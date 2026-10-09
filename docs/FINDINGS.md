# Findings

What we learned building voice chat on SpacetimeDB 2.11: the numbers, the quirks, and what we'd like upstream.

## Numbers

Measured on a 2-vCPU VM with the server and all clients on the same machine, so treat them as a floor for latency and
a rough guide for throughput. The load test is [`tests/bench.mts`](../tests/bench.mts): 60-byte frames every 20 ms
per speaker.

| Scenario | Sends/s | Delivered | Latency p50 / p95 / p99 | Wire per delivered frame |
|---|---|---|---|---|
| 1 speaker → 1 listener | 45 | 100% | 3.1 / 4.3 / 5.4 ms | 146 B |
| 5 speakers → 10 listeners | 228 | 100% | 2.0 / 4.6 / 7.8 ms | 125 B |
| 10 speakers → 30 listeners, Rust | 460 | 100% (117k frames) | 2.3 / 5.3 / 13.6 ms | 123 B |
| 10 speakers → 30 listeners, C# (NativeAOT) | 454 | 100% | 2.6 / 10.6 / 18.6 ms | 123 B |
| 10 speakers → 30 listeners, TypeScript | 458 | 100% | 2.4 / 5.8 / 12.1 ms | 123 B |
| 25 speakers → 50 listeners, Rust | 1069 | 81%, seconds behind | | |

The last row saturated the VM. The 75 clients run in one Node process on the same two cores as the server, so this
measures the box, not SpacetimeDB's ceiling. Ten people talking at once is already a shouting match. Real rooms have one
or two speakers at a time, and the cost scales with speakers × listeners.

The real browser round trip (headless Chromium, fake mic, through the module, decoded and played) also measures p50
~2 ms send → receive. What you hear on top of that is the jitter buffer (40-80 ms) plus the Opus frame (20 ms) plus
audio device latency.

**Bandwidth.** A 20 ms Opus frame at 24 kbit/s is ~57 B. After the protocol's per-row and per-transaction overhead it's
~123 B on the wire, roughly 2× the payload, which works out to ~6 KB/s per listener per active speaker. Longer frames
amortise the overhead: 40 ms frames halve the reducer calls and the per-packet cost, for 20 ms more latency.

## RLS on event tables

Reported upstream: [#6130](https://github.com/clockworklabs/SpacetimeDB/issues/6130) (event-table join shape), [#6129](https://github.com/clockworklabs/SpacetimeDB/issues/6129) (joined table with its own rule), [#2830](https://github.com/clockworklabs/SpacetimeDB/issues/2830) (private joined table).

Row-level security is what makes this design private: without it, any client can subscribe to `voip_packet` and
hear everything. Event tables support RLS ("with the same semantics as regular tables"), but in 2.11 there are
some sharp edges. Every one of these was hit and checked:

1. **The joined table can't be private.** A rule joining a private `voip_listen` fails at subscribe time with
   `no such table: voip_listen. If the table exists, it may be marked private.` The rule is evaluated with the
   subscriber's permissions.
2. **The joined table can't have RLS of its own.** Adding `SELECT * FROM voip_listen WHERE listener = :sender` (to hide
   listen rows) makes the packet subscription fail with `Subscriptions require indexes on join columns`, even with the
   anchor from (4). The recursive expansion rebuilds the join with `voip_listen` on the scan side, which leaves the
   event table as the (unindexable) lookup side. So `voip_listen` is public, and its keys are opaque (below).
3. **Don't index the event table.** With an index on `voip_packet.audience`, the planner chooses the event table as
   the index-lookup side, and the subscription fails with `Event tables cannot be used as the lookup table…`.
4. **The rule needs a predicate on the event table.** Without one, the plan starts from `voip_listen` (it has the
   `:sender` filter) and probes `voip_packet`, which then needs an index, which you can't add (3). An always-true
   `voip_packet.speaker != 0` anchors the scan on the event table, and everything works. It's fragile, since it
   depends on planner behaviour, but it holds in 2.11.
5. **Self-echo: use a client predicate.** Excluding the sender inside the rule needs the sender's identity on every
   packet (32 bytes, which is half an Opus frame) or a cross-table comparison like
   `voip_packet.speaker != voip_listen.self_id`. That isn't a predicate on the event table alone, so it doesn't anchor the
   plan, and it fails like (4). Instead the client subscribes with `WHERE speaker != <own id>`, which is ANDed with the
   rule, so the server never sends you your own packets.

Upstream wish: let event tables be the lookup side of a join. The docs list it as deferred. That would make (2)-(4)
go away, and allow a private (or RLS-protected) listen table.

### What a public `voip_listen` reveals

Room membership is already public (`voip_peer.room_id`). For proximity rooms, listen keys are cell ids **numbered in
first-use order** (`voip_cell` is private), not hashes of coordinates, so they can't be reversed into positions.
What leaks is the overlap: two players listening to the same cells are near each other. That's roughly what you'd
learn by hearing them anyway, but if your game hides positions, know that it's there.

## Other things worth knowing

- **The module owner bypasses RLS.** Connect with the token you publish with and you'll receive every packet in
  the database. Use a different identity when testing delivery.
- **Event rows are in the commit log.** The docs say so ("the inserts are still recorded in the commitlog"). Voice
  never becomes table state, but every frame is written to disk along with the transaction: about 3 KB/s per active
  speaker at 24 kbit/s, ~11 MB per speaker-hour, before compression. Think about retention and privacy
  (recorded conversations) for your deployment.
- **One reducer call per frame works fine.** At 50 calls/s per speaker, a busy room is a few hundred calls per second,
  well within what one module handles. The per-speaker rate limit costs one private row update per packet; set
  `rate_bytes_per_sec = 0` to skip it if you trust your clients.
- **Submodule names are namespaced.** The TypeScript submodule's tables and reducers are `voip.packet`, `voip.join`.
  Rust and C# modules can't produce dotted names, so clients have to handle both
  ([`api.ts`](../demo/web/src/api.ts)). Submodules also can't declare RLS filters or lifecycle reducers, so the consumer
  adds the filter (`voip.packetFilterSql('voip')` builds it) and calls `onConnect`/`onDisconnect`. A filter on
  namespaced tables works fine.
- **C# and Rust produce identical canonical schemas.** `Accessor = "VoipPeer"` with field `RoomId` canonicalises to
  `voip_peer.room_id`, the same as Rust, so one set of client bindings works with both. Only the client-side index
  accessor aliases differ.

## Bug: C# generated `Equals(object)` recurses forever on structs (reported: [#6124](https://github.com/clockworklabs/SpacetimeDB/issues/6124))

In SpacetimeDB 2.11's C# codegen (`crates/bindings-csharp/BSATN.Codegen/Type.cs`, around line 813), the generated
`Equals(object? that)` for a `[SpacetimeDB.Type]` **struct** does:

```csharp
var that_ = that as VoipCellCoord?;   // Nullable<VoipCellCoord>
if (((object?)that_) == null) return false;
return Equals(that_);                 // binds to Equals(object?) again: boxes and recurses
```

For structs, `that_` is a `Nullable<T>`. There's no `Equals(T?)` overload, so the call resolves back to
`Equals(object?)`, and the reducer traps with a stack overflow. `object.Equals(a, b)`, `EqualityComparer<T>.Default`
on boxed values, and anything else that goes through `Equals(object)` will hit it. The fix is
`return Equals(that_.Value);`. `Voip.cs` compares fields directly instead.

## Browser side

- **WebCodecs Opus** (`AudioEncoder`/`AudioDecoder`) handles encode and decode with no WASM. Chrome accepts
  `opus: { frameDuration, application, signal, complexity }`.
- **AudioContext sample rates:** Firefox can't connect a mic stream to an `AudioContext` with a different sample rate,
  so the client uses the default rate and resamples to and from 48 kHz inside its AudioWorklets.
- **Noise suppression eats test tones.** Chrome's built-in noise suppression treats a steady sine as noise. The tests
  (and the demo's `?raw=1`) turn the processing off.
- **A jitter buffer per speaker matters.** Packets arrive in bursts (one WebSocket, batched commits). Scheduling each
  one as an `AudioBufferSourceNode` (the naive approach) clicks. A ring buffer in an AudioWorklet that waits for
  ~80 ms, grows its target on underrun, and shrinks it while playback is smooth plays cleanly; the e2e runs see 0-1
  underruns per session.
