//! # voip.rs: voice chat for SpacetimeDB, one drop-in file
//!
//! Copy this file to your module's `src/voip.rs`, add `pub mod voip;` to `lib.rs`, enable the
//! `unstable` feature on the `spacetimedb` crate (row-level security needs it), and call the
//! connect/disconnect hooks from your lifecycle reducers:
//!
//! ```ignore
//! #[spacetimedb::reducer(client_connected)]
//! pub fn connected(ctx: &ReducerContext) { voip::on_connect(ctx); }
//!
//! #[spacetimedb::reducer(client_disconnected)]
//! pub fn disconnected(ctx: &ReducerContext) { voip::on_disconnect(ctx); }
//! ```
//!
//! What it gives you:
//!
//! - **Rooms.** Everyone in a room hears everyone else in it. Rooms can be created by your
//!   module (persistent, optionally `locked` so only your code can put people in them) or by
//!   clients (transient, deleted when the last person leaves).
//! - **Proximity voice.** A `spatial` room splits space into cubes of `range` metres. A speaker
//!   is heard in the 27 cubes around them, and every packet carries the speaker's position so
//!   the client can fade and pan by distance. Your module sets positions with [`set_position`]
//!   from its own movement code, so they're authoritative.
//! - **Targeted delivery.** Packets go into the `voip_packet` event table (never stored as
//!   state) and row-level security delivers each one only to the clients listening to its
//!   audience. Nobody can subscribe to a room they're not in.
//! - **Guard rails.** Size cap, per-speaker token-bucket rate limit, self mute, server mute,
//!   deafen (which stops delivery entirely, not just playback).
//!
//! The module never decodes audio. Clients encode Opus (WebCodecs in the browser, Concentus in
//! C#/Unity) and the module only routes the bytes.

use spacetimedb::{
    Filter, Identity, ReducerContext, SpacetimeType, Table, Timestamp, client_visibility_filter,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Tunables. Defaults suit 20-60 ms Opus frames at up to ~40 kbit/s.
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct VoipSettings {
    /// Largest accepted packet payload, in bytes. One 20 ms Opus frame at 24 kbit/s is ~60.
    pub max_packet_bytes: u32,
    /// Token-bucket refill rate per speaker, in bytes per second (payload + `packet_overhead`).
    /// 0 turns rate limiting off (and saves one row write per packet).
    pub rate_bytes_per_sec: u32,
    /// Token-bucket size: how far a speaker can burst above the rate.
    pub burst_bytes: u32,
    /// Bytes charged per packet on top of its payload, so tiny packets can't flood the reducer.
    pub packet_overhead: u32,
    /// Whether clients may create (transient) rooms with `voip_create_room`.
    pub clients_create_rooms: bool,
}

impl Default for VoipSettings {
    fn default() -> Self {
        Self {
            max_packet_bytes: 1500,
            rate_bytes_per_sec: 8_000,
            burst_bytes: 16_000,
            packet_overhead: 32,
            clients_create_rooms: true,
        }
    }
}

/// Options for [`create_room`].
#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct VoipRoomOptions {
    /// Proximity voice: hear only people within `range`.
    pub spatial: bool,
    /// Spatial rooms: how far a voice carries, in your world units. Also the grid cell size.
    pub range: f32,
    /// Only your module's code (via [`join`]) can put people in a locked room.
    pub locked: bool,
    /// 0 = unlimited.
    pub max_peers: u32,
}

impl Default for VoipRoomOptions {
    fn default() -> Self {
        Self {
            spatial: false,
            range: 30.0,
            locked: false,
            max_peers: 0,
        }
    }
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq)]
pub struct VoipVec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// `flags` bit: the last packet of a talk spurt (the speaker stopped talking).
pub const VOIP_FLAG_END: u8 = 1;

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

#[spacetimedb::table(accessor = voip_config)]
pub struct VoipConfig {
    #[primary_key]
    pub key: u8,
    pub settings: VoipSettings,
}

#[spacetimedb::table(accessor = voip_room, public)]
#[derive(Clone)]
pub struct VoipRoom {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub name: String,
    pub spatial: bool,
    pub range: f32,
    pub locked: bool,
    pub max_peers: u32,
    /// `None` for rooms your module created (persistent). Client rooms are deleted when empty.
    pub owner: Option<Identity>,
    pub created_at: Timestamp,
}

/// Everyone who has used voice, and what they're doing now. `id` is the short id that
/// tags their packets (stable per identity, never 0).
#[spacetimedb::table(accessor = voip_peer, public)]
#[derive(Clone)]
pub struct VoipPeer {
    #[primary_key]
    pub identity: Identity,
    #[unique]
    #[auto_inc]
    pub id: u32,
    /// 0 = not in a room.
    #[index(btree)]
    pub room_id: u64,
    pub online: bool,
    pub muted: bool,
    pub deafened: bool,
    pub server_muted: bool,
    pub joined_at: Timestamp,
}

/// Which audiences each client hears. Public because row-level security on event tables
/// can only join public tables without RLS of their own (SpacetimeDB 2.11). Audience keys are
/// opaque: a room's id, or an auto-incremented cell id with the top bit set.
#[spacetimedb::table(accessor = voip_listen, public)]
pub struct VoipListen {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub listener: Identity,
    #[index(btree)]
    pub audience: u64,
}

/// Hot per-speaker state, read (and, with rate limiting on, written) once per packet.
/// Private so packet traffic doesn't fan out row updates to every client.
#[spacetimedb::table(accessor = voip_speaker)]
pub struct VoipSpeaker {
    #[primary_key]
    pub identity: Identity,
    pub peer_id: u32,
    /// Where this speaker's packets go; 0 = nowhere (not in a room, or spatial without a position).
    pub audience: u64,
    pub can_speak: bool,
    pub spatial: bool,
    pub pos: Option<VoipVec3>,
    /// Current spatial cell (valid when `pos` is set and the room is spatial).
    pub cell: Option<VoipCellCoord>,
    pub tokens: f64,
    pub refilled_at: Timestamp,
}

#[derive(SpacetimeType, Clone, Copy, Debug, PartialEq)]
pub struct VoipCellCoord {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Spatial cells, numbered as they're first used, so audience keys reveal nothing about
/// where a cell is.
#[spacetimedb::table(
    accessor = voip_cell,
    index(accessor = by_coord, btree(columns = [room_id, x, y, z]))
)]
pub struct VoipCell {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub room_id: u64,
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

/// Voice packets. An event table: rows are broadcast on commit and never stored as state.
///
/// Do NOT add an index here: it flips the RLS join so the event table becomes the lookup
/// side, which SpacetimeDB 2.11 rejects.
#[spacetimedb::table(accessor = voip_packet, public, event)]
pub struct VoipPacket {
    pub audience: u64,
    /// The speaker's `voip_peer.id`.
    pub speaker: u32,
    pub seq: u32,
    pub flags: u8,
    /// Spatial rooms only: where the speaker was.
    pub pos: Option<VoipVec3>,
    /// One encoded frame (Opus).
    pub data: Vec<u8>,
}

/// Deliver a packet only to clients listening to its audience.
///
/// `speaker != 0` is always true; it anchors the join so the planner scans the event table
/// and looks up `voip_listen` by index. Clients add `WHERE speaker != <own id>` to their
/// subscription to skip their own packets.
#[client_visibility_filter]
const VOIP_PACKET_FILTER: Filter = Filter::Sql(
    "SELECT voip_packet.* FROM voip_packet JOIN voip_listen ON voip_packet.audience = voip_listen.audience WHERE voip_listen.listener = :sender AND voip_packet.speaker != 0",
);

/// Top bit marks spatial-cell audiences, so they never collide with room ids.
const CELL_BIT: u64 = 1 << 63;
const MAX_ROOM_NAME: usize = 32;

// ---------------------------------------------------------------------------
// Library API: call these from your own reducers
// ---------------------------------------------------------------------------

/// Store settings (call from `init`, or any time later). Without a call, defaults apply.
pub fn configure(ctx: &ReducerContext, settings: VoipSettings) {
    let row = VoipConfig { key: 0, settings };
    if ctx.db.voip_config().key().find(0).is_some() {
        ctx.db.voip_config().key().update(row);
    } else {
        ctx.db.voip_config().insert(row);
    }
}

pub fn settings(ctx: &ReducerContext) -> VoipSettings {
    ctx.db
        .voip_config()
        .key()
        .find(0)
        .map(|c| c.settings)
        .unwrap_or_default()
}

/// Create a persistent room owned by the module. Returns its id.
pub fn create_room(
    ctx: &ReducerContext,
    name: &str,
    options: VoipRoomOptions,
) -> Result<u64, String> {
    insert_room(ctx, name, options, None)
}

/// Delete a room, removing everyone from it.
pub fn delete_room(ctx: &ReducerContext, room_id: u64) {
    let peers: Vec<VoipPeer> = ctx.db.voip_peer().room_id().filter(room_id).collect();
    for peer in peers {
        ctx.db.voip_peer().identity().update(VoipPeer {
            room_id: 0,
            ..peer.clone()
        });
        refresh(ctx, peer.identity);
    }
    for cell in ctx
        .db
        .voip_cell()
        .room_id()
        .filter(room_id)
        .collect::<Vec<_>>()
    {
        ctx.db.voip_cell().id().delete(cell.id);
    }
    ctx.db.voip_room().id().delete(room_id);
}

/// Put someone in a room, bypassing `locked` (your module decides who may join).
pub fn join(ctx: &ReducerContext, who: Identity, room_id: u64) -> Result<(), String> {
    let room = ctx
        .db
        .voip_room()
        .id()
        .find(room_id)
        .ok_or("no such room")?;
    let peer = ensure_peer(ctx, who);
    if peer.room_id == room_id {
        return Ok(());
    }
    if room.max_peers > 0
        && ctx.db.voip_peer().room_id().filter(room_id).count() as u32 >= room.max_peers
    {
        return Err("room is full".into());
    }
    let old = peer.room_id;
    ctx.db.voip_peer().identity().update(VoipPeer {
        room_id,
        joined_at: ctx.timestamp,
        ..peer
    });
    refresh(ctx, who);
    cleanup_room(ctx, old);
    Ok(())
}

/// Take someone out of whatever room they're in.
pub fn leave(ctx: &ReducerContext, who: Identity) {
    let Some(peer) = ctx.db.voip_peer().identity().find(who) else {
        return;
    };
    let old = peer.room_id;
    if old == 0 {
        return;
    }
    ctx.db
        .voip_peer()
        .identity()
        .update(VoipPeer { room_id: 0, ..peer });
    refresh(ctx, who);
    cleanup_room(ctx, old);
}

/// Set someone's position for proximity voice. Call it from your movement code; cheap when
/// the position stays in the same cell (one private row update).
pub fn set_position(ctx: &ReducerContext, who: Identity, pos: VoipVec3) {
    let peer = ensure_peer(ctx, who);
    let mut speaker = ensure_speaker(ctx, &peer);
    speaker.pos = Some(pos);
    let moved_cell = speaker.spatial && {
        let room = ctx.db.voip_room().id().find(peer.room_id);
        room.map(|r| Some(cell_of(pos, r.range)) != speaker.cell)
            .unwrap_or(false)
    };
    ctx.db.voip_speaker().identity().update(speaker);
    if moved_cell {
        refresh(ctx, who);
    }
}

/// Clear someone's position: they stop hearing and being heard in spatial rooms.
pub fn clear_position(ctx: &ReducerContext, who: Identity) {
    if let Some(speaker) = ctx.db.voip_speaker().identity().find(who) {
        ctx.db.voip_speaker().identity().update(VoipSpeaker {
            pos: None,
            ..speaker
        });
        refresh(ctx, who);
    }
}

/// Server mute (moderation): the person can still hear but their packets are rejected.
pub fn set_server_muted(ctx: &ReducerContext, who: Identity, muted: bool) {
    let peer = ensure_peer(ctx, who);
    ctx.db.voip_peer().identity().update(VoipPeer {
        server_muted: muted,
        ..peer
    });
    refresh(ctx, who);
}

/// Call from your `client_connected` reducer.
pub fn on_connect(ctx: &ReducerContext) {
    let peer = ensure_peer(ctx, ctx.sender());
    if !peer.online {
        ctx.db.voip_peer().identity().update(VoipPeer {
            online: true,
            ..peer
        });
    }
}

/// Call from your `client_disconnected` reducer.
pub fn on_disconnect(ctx: &ReducerContext) {
    let who = ctx.sender();
    let Some(peer) = ctx.db.voip_peer().identity().find(who) else {
        return;
    };
    let old = peer.room_id;
    ctx.db.voip_peer().identity().update(VoipPeer {
        room_id: 0,
        online: false,
        muted: false,
        deafened: false,
        ..peer
    });
    refresh(ctx, who);
    ctx.db.voip_speaker().identity().delete(who);
    cleanup_room(ctx, old);
}

// ---------------------------------------------------------------------------
// Client reducers
// ---------------------------------------------------------------------------

/// Create a transient room (deleted when empty) and join it.
#[spacetimedb::reducer]
pub fn voip_create_room(
    ctx: &ReducerContext,
    name: String,
    spatial: bool,
    range: f32,
) -> Result<(), String> {
    if !settings(ctx).clients_create_rooms {
        return Err("only the server can create rooms".into());
    }
    let options = VoipRoomOptions {
        spatial,
        range,
        ..Default::default()
    };
    let id = insert_room(ctx, &name, options, Some(ctx.sender()))?;
    join(ctx, ctx.sender(), id)
}

#[spacetimedb::reducer]
pub fn voip_join(ctx: &ReducerContext, room_id: u64) -> Result<(), String> {
    let room = ctx
        .db
        .voip_room()
        .id()
        .find(room_id)
        .ok_or("no such room")?;
    if room.locked {
        return Err("room is locked".into());
    }
    join(ctx, ctx.sender(), room_id)
}

#[spacetimedb::reducer]
pub fn voip_leave(ctx: &ReducerContext) {
    leave(ctx, ctx.sender());
}

#[spacetimedb::reducer]
pub fn voip_set_muted(ctx: &ReducerContext, muted: bool) {
    let peer = ensure_peer(ctx, ctx.sender());
    ctx.db
        .voip_peer()
        .identity()
        .update(VoipPeer { muted, ..peer });
    refresh(ctx, ctx.sender());
}

/// Deafened clients stop receiving packets at all (saves their bandwidth). Deafening also mutes.
#[spacetimedb::reducer]
pub fn voip_set_deafened(ctx: &ReducerContext, deafened: bool) {
    let peer = ensure_peer(ctx, ctx.sender());
    ctx.db
        .voip_peer()
        .identity()
        .update(VoipPeer { deafened, ..peer });
    refresh(ctx, ctx.sender());
}

/// A transient room's owner can server-mute people in it.
#[spacetimedb::reducer]
pub fn voip_moderate(ctx: &ReducerContext, target: Identity, muted: bool) -> Result<(), String> {
    let me = ctx
        .db
        .voip_peer()
        .identity()
        .find(ctx.sender())
        .ok_or("not in a room")?;
    let room = ctx
        .db
        .voip_room()
        .id()
        .find(me.room_id)
        .ok_or("not in a room")?;
    if room.owner != Some(ctx.sender()) {
        return Err("only the room's owner can moderate".into());
    }
    let them = ctx
        .db
        .voip_peer()
        .identity()
        .find(target)
        .ok_or("no such peer")?;
    if them.room_id != room.id {
        return Err("they're not in your room".into());
    }
    set_server_muted(ctx, target, muted);
    Ok(())
}

/// Send one encoded frame to the sender's current audience.
#[spacetimedb::reducer]
pub fn voip_send(ctx: &ReducerContext, seq: u32, flags: u8, data: Vec<u8>) -> Result<(), String> {
    let mut speaker = ctx
        .db
        .voip_speaker()
        .identity()
        .find(ctx.sender())
        .ok_or("not in a voice room")?;
    if !speaker.can_speak || speaker.audience == 0 {
        return Err("can't speak here (muted, or no position in a spatial room)".into());
    }
    let s = settings(ctx);
    if data.len() > s.max_packet_bytes as usize {
        return Err("packet too large".into());
    }
    let (audience, peer_id) = (speaker.audience, speaker.peer_id);
    let pos = if speaker.spatial { speaker.pos } else { None };
    if s.rate_bytes_per_sec > 0 {
        let elapsed_us = ctx.timestamp.to_micros_since_unix_epoch()
            - speaker.refilled_at.to_micros_since_unix_epoch();
        let refill = elapsed_us.max(0) as f64 / 1e6 * s.rate_bytes_per_sec as f64;
        let tokens = (speaker.tokens + refill).min(s.burst_bytes as f64);
        let cost = (data.len() as u32 + s.packet_overhead) as f64;
        if tokens < cost {
            return Err("rate limited".into());
        }
        speaker.tokens = tokens - cost;
        speaker.refilled_at = ctx.timestamp;
        ctx.db.voip_speaker().identity().update(speaker);
    }
    ctx.db.voip_packet().insert(VoipPacket {
        audience,
        speaker: peer_id,
        seq,
        flags,
        pos,
        data,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn insert_room(
    ctx: &ReducerContext,
    name: &str,
    options: VoipRoomOptions,
    owner: Option<Identity>,
) -> Result<u64, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_ROOM_NAME {
        return Err(format!("room name must be 1-{MAX_ROOM_NAME} characters"));
    }
    if ctx.db.voip_room().name().find(name.to_string()).is_some() {
        return Err("a room with that name exists".into());
    }
    if options.spatial && !(options.range.is_finite() && options.range > 0.0) {
        return Err("spatial rooms need a positive range".into());
    }
    let room = ctx.db.voip_room().insert(VoipRoom {
        id: 0,
        name: name.to_string(),
        spatial: options.spatial,
        range: options.range,
        locked: options.locked,
        max_peers: options.max_peers,
        owner,
        created_at: ctx.timestamp,
    });
    if room.id & CELL_BIT != 0 {
        return Err("room id space exhausted".into());
    }
    Ok(room.id)
}

/// Delete a client-created room once it's empty.
fn cleanup_room(ctx: &ReducerContext, room_id: u64) {
    if room_id == 0 {
        return;
    }
    let Some(room) = ctx.db.voip_room().id().find(room_id) else {
        return;
    };
    if room.owner.is_some()
        && ctx
            .db
            .voip_peer()
            .room_id()
            .filter(room_id)
            .next()
            .is_none()
    {
        delete_room(ctx, room_id);
    }
}

fn ensure_peer(ctx: &ReducerContext, who: Identity) -> VoipPeer {
    if let Some(peer) = ctx.db.voip_peer().identity().find(who) {
        return peer;
    }
    ctx.db.voip_peer().insert(VoipPeer {
        identity: who,
        id: 0,
        room_id: 0,
        online: true,
        muted: false,
        deafened: false,
        server_muted: false,
        joined_at: ctx.timestamp,
    })
}

fn ensure_speaker(ctx: &ReducerContext, peer: &VoipPeer) -> VoipSpeaker {
    if let Some(speaker) = ctx.db.voip_speaker().identity().find(peer.identity) {
        return speaker;
    }
    ctx.db.voip_speaker().insert(VoipSpeaker {
        identity: peer.identity,
        peer_id: peer.id,
        audience: 0,
        can_speak: false,
        spatial: false,
        pos: None,
        cell: None,
        tokens: settings(ctx).burst_bytes as f64,
        refilled_at: ctx.timestamp,
    })
}

fn cell_of(pos: VoipVec3, range: f32) -> VoipCellCoord {
    let c = |v: f32| (v / range).floor().clamp(i32::MIN as f32, i32::MAX as f32) as i32;
    VoipCellCoord {
        x: c(pos.x),
        y: c(pos.y),
        z: c(pos.z),
    }
}

fn cell_audience(ctx: &ReducerContext, room_id: u64, c: VoipCellCoord) -> u64 {
    let existing = ctx
        .db
        .voip_cell()
        .by_coord()
        .filter((room_id, c.x, c.y, c.z))
        .next();
    let id = match existing {
        Some(cell) => cell.id,
        None => {
            ctx.db
                .voip_cell()
                .insert(VoipCell {
                    id: 0,
                    room_id,
                    x: c.x,
                    y: c.y,
                    z: c.z,
                })
                .id
        }
    };
    id | CELL_BIT
}

/// Recompute where someone's packets go and what they hear, and sync `voip_listen` to it.
fn refresh(ctx: &ReducerContext, who: Identity) {
    let Some(peer) = ctx.db.voip_peer().identity().find(who) else {
        return;
    };
    let room = (peer.room_id != 0 && peer.online)
        .then(|| ctx.db.voip_room().id().find(peer.room_id))
        .flatten();
    let mut speaker = ensure_speaker(ctx, &peer);

    let mut audience = 0;
    let mut hears: Vec<u64> = Vec::new();
    speaker.spatial = false;
    speaker.cell = None;
    if let Some(room) = &room {
        if !room.spatial {
            audience = room.id;
            hears.push(room.id);
        } else if let Some(pos) = speaker.pos {
            let c = cell_of(pos, room.range);
            speaker.spatial = true;
            speaker.cell = Some(c);
            audience = cell_audience(ctx, room.id, c);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let n = VoipCellCoord {
                            x: c.x.saturating_add(dx),
                            y: c.y.saturating_add(dy),
                            z: c.z.saturating_add(dz),
                        };
                        hears.push(cell_audience(ctx, room.id, n));
                    }
                }
            }
        }
    }
    if peer.deafened {
        hears.clear();
    }
    speaker.audience = audience;
    speaker.can_speak = audience != 0 && !peer.muted && !peer.deafened && !peer.server_muted;
    ctx.db.voip_speaker().identity().update(speaker);

    // Sync listen rows: delete what's no longer heard, add what's new.
    hears.sort_unstable();
    hears.dedup();
    let current: Vec<VoipListen> = ctx.db.voip_listen().listener().filter(who).collect();
    for row in &current {
        if hears.binary_search(&row.audience).is_err() {
            ctx.db.voip_listen().id().delete(row.id);
        }
    }
    for a in hears {
        if !current.iter().any(|r| r.audience == a) {
            ctx.db.voip_listen().insert(VoipListen {
                id: 0,
                listener: who,
                audience: a,
            });
        }
    }
}
