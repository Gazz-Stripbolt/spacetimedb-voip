/**
 * # spacetimedb-voip: voice chat for SpacetimeDB, as a submodule
 *
 * The TypeScript twin of `rust/voip.rs` and `csharp/Voip.cs`: rooms, proximity voice,
 * targeted delivery through an event table + row-level security, rate limiting and
 * moderation. The module never decodes audio; clients encode Opus and it routes the bytes.
 *
 * Mount it with `schema({ ..., voip })`, then see `README.md` for the few lines a consumer
 * adds (lifecycle hooks and the row-level-security filter, which submodules can't declare
 * for themselves).
 */
import { schema, table, t, SenderError } from 'spacetimedb/server';
import type { ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const VoipSettings = t.object('VoipSettings', {
  /** Largest accepted packet payload, in bytes. */
  maxPacketBytes: t.u32(),
  /** Token-bucket refill per speaker, bytes/s (payload + packetOverhead). 0 = off. */
  rateBytesPerSec: t.u32(),
  /** Token-bucket size: how far a speaker can burst above the rate. */
  burstBytes: t.u32(),
  /** Bytes charged per packet on top of its payload. */
  packetOverhead: t.u32(),
  /** Whether clients may create (transient) rooms. */
  clientsCreateRooms: t.bool(),
});
export type Settings = {
  maxPacketBytes: number;
  rateBytesPerSec: number;
  burstBytes: number;
  packetOverhead: number;
  clientsCreateRooms: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  maxPacketBytes: 1500,
  rateBytesPerSec: 8_000,
  burstBytes: 16_000,
  packetOverhead: 32,
  clientsCreateRooms: true,
};

export interface RoomOptions {
  /** Proximity voice: hear only people within `range`. */
  spatial?: boolean;
  /** Spatial rooms: how far a voice carries (also the grid cell size). Default 30. */
  range?: number;
  /** Only your module's code (via `joinRoom`) can put people in a locked room. */
  locked?: boolean;
  /** 0 = unlimited. */
  maxPeers?: number;
}

const Vec3 = t.object('VoipVec3', { x: t.f32(), y: t.f32(), z: t.f32() });
const CellCoord = t.object('VoipCellCoord', { x: t.i32(), y: t.i32(), z: t.i32() });
export type Vec3 = { x: number; y: number; z: number };
type Cell = { x: number; y: number; z: number };

/** `flags` bit: the last packet of a talk spurt. */
export const FLAG_END = 1;
/** Top bit marks spatial-cell audiences, so they never collide with room ids. */
const CELL_BIT = 1n << 63n;
const MAX_ROOM_NAME = 32;

// ---------------------------------------------------------------------------
// Tables (they live under the consumer's namespace, e.g. `voip.packet`)
// ---------------------------------------------------------------------------

const config = table({ name: 'config' }, { key: t.u8().primaryKey(), settings: VoipSettings });

const room = table(
  { name: 'room', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    spatial: t.bool(),
    range: t.f32(),
    locked: t.bool(),
    maxPeers: t.u32(),
    /** undefined for rooms your module created (persistent). Client rooms are deleted when empty. */
    owner: t.option(t.identity()),
    createdAt: t.timestamp(),
  }
);

/** Everyone who has used voice. `id` tags their packets (stable, never 0). */
const peer = table(
  { name: 'peer', public: true },
  {
    identity: t.identity().primaryKey(),
    id: t.u32().unique().autoInc(),
    /** 0 = not in a room. */
    roomId: t.u64().index('btree'),
    online: t.bool(),
    muted: t.bool(),
    deafened: t.bool(),
    serverMuted: t.bool(),
    joinedAt: t.timestamp(),
  }
);

/**
 * Which audiences each client hears. Public because RLS on event tables can only join public
 * tables without RLS of their own (SpacetimeDB 2.11). Keys are opaque.
 */
const listen = table(
  { name: 'listen', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    listener: t.identity().index('btree'),
    audience: t.u64().index('btree'),
  }
);

/** Hot per-speaker state, read (and with rate limiting, written) once per packet. */
const speaker = table(
  { name: 'speaker' },
  {
    identity: t.identity().primaryKey(),
    peerId: t.u32(),
    /** Where this speaker's packets go; 0 = nowhere. */
    audience: t.u64(),
    canSpeak: t.bool(),
    spatial: t.bool(),
    pos: t.option(Vec3),
    cell: t.option(CellCoord),
    tokens: t.f64(),
    refilledAt: t.timestamp(),
  }
);

/** Spatial cells, numbered as first used, so audience keys reveal no coordinates. */
const cell = table(
  {
    name: 'cell',
    indexes: [{ accessor: 'byCoord', algorithm: 'btree', columns: ['roomId', 'x', 'y', 'z'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.u64().index('btree'),
    x: t.i32(),
    y: t.i32(),
    z: t.i32(),
  }
);

/**
 * Voice packets: an event table, broadcast on commit and never stored as state.
 * Do NOT index it: that flips the RLS join so the event table becomes the lookup side.
 */
const packet = table(
  { name: 'packet', public: true, event: true },
  {
    audience: t.u64(),
    /** The speaker's `peer.id`. */
    speaker: t.u32(),
    seq: t.u32(),
    flags: t.u8(),
    /** Spatial rooms only: where the speaker was. */
    pos: t.option(Vec3),
    /** One encoded frame (Opus). */
    data: t.byteArray(),
  }
);

const spacetimedb = schema({ config, room, peer, listen, speaker, cell, packet });
export default spacetimedb;

type S = typeof spacetimedb.schemaType;
/** A context narrowed to this submodule: pass `ctx.as.voip` (or whatever you named it). */
export type VoipCtx = ReducerCtx<S>;
type PeerRow = NonNullable<ReturnType<VoipCtx['db']['peer']['identity']['find']>>;

/**
 * The row-level-security rule your module must export (submodules can't contribute RLS
 * filters, so the consumer declares it). Pass the canonical namespace you mounted under:
 *
 * ```ts
 * export const voipPacketFilter = spacetimedb.clientVisibilityFilter.sql(voip.packetFilterSql('voip'));
 * ```
 *
 * `speaker != 0` is always true; it anchors the join so the planner scans the event table.
 */
export function packetFilterSql(ns: string): string {
  const p = `${ns}.packet`;
  const l = `${ns}.listen`;
  return `SELECT ${p}.* FROM ${p} JOIN ${l} ON ${p}.audience = ${l}.audience WHERE ${l}.listener = :sender AND ${p}.speaker != 0`;
}

// ---------------------------------------------------------------------------
// Library API: call these from your own reducers with `ctx.as.voip`
// ---------------------------------------------------------------------------

/** Store settings (from init, or any time later). Without a call, defaults apply. */
export function configure(ctx: VoipCtx, settings: Settings): void {
  const row = { key: 0, settings };
  if (ctx.db.config.key.find(0)) ctx.db.config.key.update(row);
  else ctx.db.config.insert(row);
}

export function settings(ctx: VoipCtx): Settings {
  return ctx.db.config.key.find(0)?.settings ?? DEFAULT_SETTINGS;
}

/** Create a persistent room owned by the module. Returns its id. */
export function newRoom(ctx: VoipCtx, name: string, options: RoomOptions = {}): bigint {
  return insertRoom(ctx, name, options, undefined);
}

/** Delete a room, removing everyone from it. */
export function deleteRoom(ctx: VoipCtx, roomId: bigint): void {
  for (const p of [...ctx.db.peer.roomId.filter(roomId)]) {
    ctx.db.peer.identity.update({ ...p, roomId: 0n });
    refresh(ctx, p.identity);
  }
  for (const c of [...ctx.db.cell.roomId.filter(roomId)]) ctx.db.cell.id.delete(c.id);
  ctx.db.room.id.delete(roomId);
}

/** Put someone in a room, bypassing `locked` (your module decides who may join). */
export function joinRoom(ctx: VoipCtx, who: Identity, roomId: bigint): void {
  const r = ctx.db.room.id.find(roomId);
  if (!r) throw new SenderError('no such room');
  const p = ensurePeer(ctx, who);
  if (p.roomId === roomId) return;
  if (r.maxPeers > 0 && [...ctx.db.peer.roomId.filter(roomId)].length >= r.maxPeers) {
    throw new SenderError('room is full');
  }
  const old = p.roomId;
  ctx.db.peer.identity.update({ ...p, roomId, joinedAt: ctx.timestamp });
  refresh(ctx, who);
  cleanupRoom(ctx, old);
}

/** Take someone out of whatever room they're in. */
export function leaveRoom(ctx: VoipCtx, who: Identity): void {
  const p = ctx.db.peer.identity.find(who);
  if (!p || p.roomId === 0n) return;
  const old = p.roomId;
  ctx.db.peer.identity.update({ ...p, roomId: 0n });
  refresh(ctx, who);
  cleanupRoom(ctx, old);
}

/** Set someone's position for proximity voice. Cheap while they stay in one cell. */
export function setPosition(ctx: VoipCtx, who: Identity, pos: Vec3): void {
  const p = ensurePeer(ctx, who);
  const s = ensureSpeaker(ctx, p);
  const r = s.spatial ? ctx.db.room.id.find(p.roomId) : undefined;
  const movedCell = !!r && !sameCell(cellOf(pos, r.range), s.cell);
  ctx.db.speaker.identity.update({ ...s, pos });
  if (movedCell) refresh(ctx, who);
}

/** Clear someone's position: they stop hearing and being heard in spatial rooms. */
export function clearPosition(ctx: VoipCtx, who: Identity): void {
  const s = ctx.db.speaker.identity.find(who);
  if (!s) return;
  ctx.db.speaker.identity.update({ ...s, pos: undefined });
  refresh(ctx, who);
}

/** Server mute (moderation): they can still hear, but their packets are rejected. */
export function setServerMuted(ctx: VoipCtx, who: Identity, muted: boolean): void {
  const p = ensurePeer(ctx, who);
  ctx.db.peer.identity.update({ ...p, serverMuted: muted });
  refresh(ctx, who);
}

/** Call from your `onConnect` lifecycle reducer. */
export function onConnect(ctx: VoipCtx): void {
  const p = ensurePeer(ctx, ctx.sender);
  if (!p.online) ctx.db.peer.identity.update({ ...p, online: true });
}

/** Call from your `onDisconnect` lifecycle reducer. */
export function onDisconnect(ctx: VoipCtx): void {
  const who = ctx.sender;
  const p = ctx.db.peer.identity.find(who);
  if (!p) return;
  const old = p.roomId;
  ctx.db.peer.identity.update({ ...p, roomId: 0n, online: false, muted: false, deafened: false });
  refresh(ctx, who);
  ctx.db.speaker.identity.delete(who);
  cleanupRoom(ctx, old);
}

// ---------------------------------------------------------------------------
// Client reducers (registered under the namespace: `voip.send`, `voip.join`, ...)
// ---------------------------------------------------------------------------

/** Create a transient room (deleted when empty) and join it. */
export const createRoom = spacetimedb.reducer(
  { name: t.string(), spatial: t.bool(), range: t.f32() },
  (ctx, { name, spatial, range }) => {
    if (!settings(ctx).clientsCreateRooms) throw new SenderError('only the server can create rooms');
    const id = insertRoom(ctx, name, { spatial, range }, ctx.sender);
    joinRoom(ctx, ctx.sender, id);
  }
);

export const join = spacetimedb.reducer({ roomId: t.u64() }, (ctx, { roomId }) => {
  const r = ctx.db.room.id.find(roomId);
  if (!r) throw new SenderError('no such room');
  if (r.locked) throw new SenderError('room is locked');
  joinRoom(ctx, ctx.sender, roomId);
});

export const leave = spacetimedb.reducer((ctx) => leaveRoom(ctx, ctx.sender));

export const setMuted = spacetimedb.reducer({ muted: t.bool() }, (ctx, { muted }) => {
  const p = ensurePeer(ctx, ctx.sender);
  ctx.db.peer.identity.update({ ...p, muted });
  refresh(ctx, ctx.sender);
});

/** Deafened clients stop receiving packets at all. Deafening also mutes. */
export const setDeafened = spacetimedb.reducer({ deafened: t.bool() }, (ctx, { deafened }) => {
  const p = ensurePeer(ctx, ctx.sender);
  ctx.db.peer.identity.update({ ...p, deafened });
  refresh(ctx, ctx.sender);
});

/** A transient room's owner can server-mute people in it. */
export const moderate = spacetimedb.reducer({ target: t.identity(), muted: t.bool() }, (ctx, { target, muted }) => {
  const me = ctx.db.peer.identity.find(ctx.sender);
  const r = me && ctx.db.room.id.find(me.roomId);
  if (!r) throw new SenderError('not in a room');
  if (!r.owner || !r.owner.isEqual(ctx.sender)) throw new SenderError("only the room's owner can moderate");
  const them = ctx.db.peer.identity.find(target);
  if (!them) throw new SenderError('no such peer');
  if (them.roomId !== r.id) throw new SenderError("they're not in your room");
  setServerMuted(ctx, target, muted);
});

/** Send one encoded frame to the sender's current audience. */
export const send = spacetimedb.reducer(
  { seq: t.u32(), flags: t.u8(), data: t.byteArray() },
  (ctx, { seq, flags, data }) => {
    const s = ctx.db.speaker.identity.find(ctx.sender);
    if (!s) throw new SenderError('not in a voice room');
    if (!s.canSpeak || s.audience === 0n) {
      throw new SenderError("can't speak here (muted, or no position in a spatial room)");
    }
    const cfg = settings(ctx);
    if (data.length > cfg.maxPacketBytes) throw new SenderError('packet too large');
    if (cfg.rateBytesPerSec > 0) {
      const elapsedUs = ctx.timestamp.microsSinceUnixEpoch - s.refilledAt.microsSinceUnixEpoch;
      const refill = (Number(elapsedUs > 0n ? elapsedUs : 0n) / 1e6) * cfg.rateBytesPerSec;
      const tokens = Math.min(s.tokens + refill, cfg.burstBytes);
      const cost = data.length + cfg.packetOverhead;
      if (tokens < cost) throw new SenderError('rate limited');
      ctx.db.speaker.identity.update({ ...s, tokens: tokens - cost, refilledAt: ctx.timestamp });
    }
    ctx.db.packet.insert({
      audience: s.audience,
      speaker: s.peerId,
      seq,
      flags,
      pos: s.spatial ? s.pos : undefined,
      data,
    });
  }
);

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function insertRoom(ctx: VoipCtx, name: string, o: RoomOptions, owner: Identity | undefined): bigint {
  name = name.trim();
  if (name.length === 0 || [...name].length > MAX_ROOM_NAME) {
    throw new SenderError(`room name must be 1-${MAX_ROOM_NAME} characters`);
  }
  if (ctx.db.room.name.find(name)) throw new SenderError('a room with that name exists');
  const range = o.range ?? 30;
  if (o.spatial && !(Number.isFinite(range) && range > 0)) throw new SenderError('spatial rooms need a positive range');
  const r = ctx.db.room.insert({
    id: 0n,
    name,
    spatial: !!o.spatial,
    range,
    locked: !!o.locked,
    maxPeers: o.maxPeers ?? 0,
    owner,
    createdAt: ctx.timestamp,
  });
  if ((r.id & CELL_BIT) !== 0n) throw new SenderError('room id space exhausted');
  return r.id;
}

/** Delete a client-created room once it's empty. */
function cleanupRoom(ctx: VoipCtx, roomId: bigint): void {
  if (roomId === 0n) return;
  const r = ctx.db.room.id.find(roomId);
  if (r?.owner && ctx.db.peer.roomId.filter(roomId).next().done) deleteRoom(ctx, roomId);
}

function ensurePeer(ctx: VoipCtx, who: Identity): PeerRow {
  return (
    ctx.db.peer.identity.find(who) ??
    ctx.db.peer.insert({
      identity: who,
      id: 0,
      roomId: 0n,
      online: true,
      muted: false,
      deafened: false,
      serverMuted: false,
      joinedAt: ctx.timestamp,
    })
  );
}

function ensureSpeaker(ctx: VoipCtx, p: PeerRow) {
  return (
    ctx.db.speaker.identity.find(p.identity) ??
    ctx.db.speaker.insert({
      identity: p.identity,
      peerId: p.id,
      audience: 0n,
      canSpeak: false,
      spatial: false,
      pos: undefined,
      cell: undefined,
      tokens: settings(ctx).burstBytes,
      refilledAt: ctx.timestamp,
    })
  );
}

const clampI32 = (v: number) => Math.max(-2147483648, Math.min(2147483647, v));
const cellOf = (pos: Vec3, range: number): Cell => ({
  x: clampI32(Math.floor(pos.x / range)),
  y: clampI32(Math.floor(pos.y / range)),
  z: clampI32(Math.floor(pos.z / range)),
});
const sameCell = (a: Cell, b: Cell | undefined) => !!b && a.x === b.x && a.y === b.y && a.z === b.z;

function cellAudience(ctx: VoipCtx, roomId: bigint, c: Cell): bigint {
  const found = ctx.db.cell.byCoord.filter([roomId, c.x, c.y, c.z]).next();
  const id = found.done ? ctx.db.cell.insert({ id: 0n, roomId, ...c }).id : found.value.id;
  return id | CELL_BIT;
}

/** Recompute where someone's packets go and what they hear; sync `listen` to it. */
function refresh(ctx: VoipCtx, who: Identity): void {
  const p = ctx.db.peer.identity.find(who);
  if (!p) return;
  const r = p.roomId !== 0n && p.online ? ctx.db.room.id.find(p.roomId) : undefined;
  const s = ensureSpeaker(ctx, p);

  let audience = 0n;
  let hears: bigint[] = [];
  let spatial = false;
  let c: Cell | undefined;
  if (r && !r.spatial) {
    audience = r.id;
    hears.push(r.id);
  } else if (r && s.pos) {
    c = cellOf(s.pos, r.range);
    spatial = true;
    audience = cellAudience(ctx, r.id, c);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          hears.push(cellAudience(ctx, r.id, { x: clampI32(c.x + dx), y: clampI32(c.y + dy), z: clampI32(c.z + dz) }));
        }
  }
  if (p.deafened) hears = [];
  const canSpeak = audience !== 0n && !p.muted && !p.deafened && !p.serverMuted;
  ctx.db.speaker.identity.update({ ...s, audience, canSpeak, spatial, cell: c });

  // Sync listen rows: delete what's no longer heard, add what's new.
  const want = new Set(hears);
  for (const row of [...ctx.db.listen.listener.filter(who)]) {
    if (!want.delete(row.audience)) ctx.db.listen.id.delete(row.id);
  }
  for (const a of want) ctx.db.listen.insert({ id: 0n, listener: who, audience: a });
}
