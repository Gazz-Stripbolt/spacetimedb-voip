# Protocol

Everything a client needs to talk to a spacetimedb-voip module: the tables, the reducers, the packet format and the
subscription. All three server implementations ([`voip.rs`](../rust/voip.rs), [`Voip.cs`](../csharp/Voip.cs) and the
[TypeScript submodule](../typescript/src/index.ts)) expose the same schema. Only the names differ for the submodule
(see [Names](#names)).

## Names

| | Rust / C# (flat) | TypeScript submodule mounted as `voip` |
|---|---|---|
| Tables | `voip_room`, `voip_peer`, `voip_listen`, `voip_packet` | `voip.room`, `voip.peer`, `voip.listen`, `voip.packet` |
| Reducers | `voip_join`, `voip_leave`, `voip_send`, `voip_set_muted`, `voip_set_deafened`, `voip_moderate`, `voip_create_room` | `voip.join`, `voip.leave`, `voip.send`, `voip.set_muted`, `voip.set_deafened`, `voip.moderate`, `voip.create_room` |

Columns, types, indexes and reducer arguments are identical. [`demo/web/src/api.ts`](../demo/web/src/api.ts) shows one
client covering both.

## Public tables

### `voip_room`

| Column | Type | |
|---|---|---|
| `id` | u64, PK, auto-inc | Never has the top bit set (that's reserved for cell audiences) |
| `name` | string, unique | 1-32 characters |
| `spatial` | bool | Proximity room |
| `range` | f32 | Spatial rooms: how far a voice carries, in the module's world units. Also the grid cell size |
| `locked` | bool | Clients can't `voip_join`; only module code can add people |
| `max_peers` | u32 | 0 = unlimited |
| `owner` | Option\<Identity\> | None = created by the module (persistent). Some = created by a client (deleted when empty) |
| `created_at` | Timestamp | |

### `voip_peer`

One row per identity that has ever used voice.

| Column | Type | |
|---|---|---|
| `identity` | Identity, PK | |
| `id` | u32, unique, auto-inc | The short id that tags this person's packets (`voip_packet.speaker`). Stable, never 0 |
| `room_id` | u64, btree | 0 = not in a room |
| `online` | bool | |
| `muted` | bool | Self-mute |
| `deafened` | bool | Self-deafen (also stops delivery and blocks sending) |
| `server_muted` | bool | Moderation |
| `joined_at` | Timestamp | |

Room members are `voip_peer WHERE room_id = X AND online`.

### `voip_listen`

Which audiences each client hears. It's maintained by the module. Clients never need to read it, but it has to be
public for the delivery rule to work (see [FINDINGS](FINDINGS.md#rls-on-event-tables)).

| Column | Type |
|---|---|
| `id` | u64, PK, auto-inc |
| `listener` | Identity, btree |
| `audience` | u64, btree |

### `voip_packet` (event table)

| Column | Type | |
|---|---|---|
| `audience` | u64 | Room id, or `cell_id \| 1 << 63` in spatial rooms |
| `speaker` | u32 | The speaker's `voip_peer.id` |
| `seq` | u32 | Sender's packet counter, +1 per packet, wraps |
| `flags` | u8 | Bit 0 (`END` = 1): last packet of a talk spurt |
| `pos` | Option\<VoipVec3 { x, y, z: f32 }\> | Spatial rooms: where the speaker was. None otherwise |
| `data` | bytes | One encoded audio frame |

## Delivery rule

Every server declares this row-level-security filter (the submodule's consumer declares it with the namespaced names):

```sql
SELECT voip_packet.* FROM voip_packet
JOIN voip_listen ON voip_packet.audience = voip_listen.audience
WHERE voip_listen.listener = :sender AND voip_packet.speaker != 0
```

## Subscribing

```sql
SELECT * FROM voip_room
SELECT * FROM voip_peer
SELECT * FROM voip_packet WHERE speaker != <your voip_peer.id>
```

The `WHERE speaker != …` is ANDed with the delivery rule, so the server skips your own packets. Your `voip_peer` row is
created when you connect, so subscribe to `voip_peer` first, read your `id`, then subscribe to packets.

## Reducers

| Reducer | Args | Errors |
|---|---|---|
| `voip_join` | `room_id: u64` | no such room · room is locked · room is full |
| `voip_leave` | | |
| `voip_send` | `seq: u32, flags: u8, data: bytes` | not in a voice room · can't speak here (muted, deafened, server-muted, or spatial without a position) · packet too large · rate limited |
| `voip_set_muted` | `muted: bool` | |
| `voip_set_deafened` | `deafened: bool` | |
| `voip_moderate` | `target: Identity, muted: bool` | Only the owner of a client-created room, for people in that room |
| `voip_create_room` | `name: string, spatial: bool, range: f32` | Creates a transient room and joins it. Can be turned off with `clients_create_rooms = false` |

`voip_send` errors are expected in normal operation (a burst over the rate limit, or a packet already in flight when
you mute). Ignore them; don't retry.

Positions are **not** settable by clients. The host module calls `set_position` from its own movement code.

## Audio

The module doesn't care what's in `data`. All clients in one deployment have to agree, though, and the reference
client uses:

- **Opus**, 48 kHz, mono, one frame per packet (20 ms by default; 10, 40 and 60 ms also work). Each frame is
  self-describing (TOC byte), so decoders handle mixed frame sizes.
- **VBR ~24 kbit/s**, application `voip`, no in-band FEC, no DTX. The noise gate stops sending instead.
- **Talk spurts:** a sender sends nothing while silent, sends a couple of frames of pre-roll when the gate opens,
  and sets `END` on the first frame after it closes. Receivers drain their buffer on `END` instead of counting it as
  an underrun.

Delivery is in order per speaker (one WebSocket, ordered commits), so receivers don't need reordering. Gaps in `seq`
mean rejected packets (rate limit) or a new spurt.

### Writing a native client (Unity, Godot, …)

1. Connect with the SpacetimeDB SDK for your engine and generate bindings from the module.
2. Subscribe as above. On each `voip_packet` insert, route `data` to that speaker's Opus decoder
   ([Concentus](https://github.com/lostromb/concentus) in C#), then into a per-speaker jitter buffer of ~60-100 ms
   that refills after an underrun.
3. Capture 48 kHz mono, run a level gate (or push-to-talk), encode 20 ms Opus frames and call `voip_send` with an
   incrementing `seq`.
4. In spatial rooms, position each speaker's audio source at `pos`, and fade it to silence at the room's `range`.
