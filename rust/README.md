# voip.rs: voice chat for Rust modules

One file. Copy [`voip.rs`](voip.rs) to your module's `src/voip.rs`.

```toml
# Cargo.toml: row-level security (how packets reach only their listeners) needs `unstable`
spacetimedb = { version = "2.11.*", features = ["unstable"] }
```

```rust
pub mod voip;
use voip::{VoipRoomOptions, VoipVec3};

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) -> Result<(), String> {
    voip::configure(ctx, voip::VoipSettings::default());              // optional
    voip::create_room(ctx, "Lobby", VoipRoomOptions::default())?;
    voip::create_room(ctx, "Proximity", VoipRoomOptions { spatial: true, range: 30.0, ..Default::default() })?;
    Ok(())
}

#[spacetimedb::reducer(client_connected)]
pub fn connected(ctx: &ReducerContext) { voip::on_connect(ctx); }

#[spacetimedb::reducer(client_disconnected)]
pub fn disconnected(ctx: &ReducerContext) { voip::on_disconnect(ctx); }
```

A complete module is in [`demo/rust`](../demo/rust/src/lib.rs).

## What you get

**Client reducers:** `voip_join`, `voip_leave`, `voip_send`, `voip_set_muted`, `voip_set_deafened`, `voip_moderate`,
`voip_create_room`. **Public tables:** `voip_room`, `voip_peer`, `voip_listen`, `voip_packet` (event table). See
[PROTOCOL.md](../docs/PROTOCOL.md).

**Library functions** for your own reducers:

| Function | |
|---|---|
| `configure(ctx, VoipSettings)` | Size cap, rate limit, whether clients can create rooms |
| `create_room(ctx, name, VoipRoomOptions) -> Result<u64>` | Persistent room. `spatial`, `range`, `locked`, `max_peers` |
| `delete_room(ctx, id)` | Removes everyone from it first |
| `join(ctx, who, room_id)` / `leave(ctx, who)` | Bypasses `locked`, so gate joins with your own rules |
| `set_position(ctx, who, VoipVec3)` | Call it from your movement code. Cheap unless the person crosses a cell boundary |
| `clear_position(ctx, who)` | They stop hearing and being heard in spatial rooms |
| `set_server_muted(ctx, who, bool)` | Moderation |
| `on_connect(ctx)` / `on_disconnect(ctx)` | Lifecycle hooks |

**Locked rooms** are how you do team or party voice: `create_room(.., VoipRoomOptions { locked: true, .. })`, then
`voip::join(ctx, member, room)` from your own `join_team` reducer.
