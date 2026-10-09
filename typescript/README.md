# spacetimedb-voip for TypeScript (submodule)

Voice chat as a **SpacetimeDB submodule**. Mount it, and your module gets rooms, proximity voice and private
packet delivery.

Source: [`src/index.ts`](src/index.ts) · Complete example: [`demo/typescript`](../demo/typescript/src/index.ts) ·
Protocol: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md)

## Install

It isn't on npm yet. Copy this folder into your repo and add it as an npm workspace package, so there's only one
copy of the `spacetimedb` package (two copies make `spacetime publish` fail with *"Local module schema inspection
failed"*):

```jsonc
// package.json at your repo root
{ "private": true, "workspaces": ["spacetimedb-voip", "my-module"] }
// my-module/package.json
{ "dependencies": { "spacetimedb": "2.11.*", "spacetimedb-voip": "0.1.0" } }
```

## Wire it up

Submodules can't declare row-level-security filters or lifecycle reducers, so your module adds them:

```typescript
import { schema } from 'spacetimedb/server';
import * as voip from 'spacetimedb-voip';                // `import * as`, not a default import

const spacetimedb = schema({ /* your tables */, voip });  // mounted under the namespace "voip"
export default spacetimedb;

// The delivery rule: each packet only reaches its listeners. Pass the canonical namespace.
export const voipPacketFilter = spacetimedb.clientVisibilityFilter.sql(voip.packetFilterSql('voip'));

export const init = spacetimedb.init((ctx) => {
  voip.newRoom(ctx.as.voip, 'Lobby');
  voip.newRoom(ctx.as.voip, 'Proximity', { spatial: true, range: 30 });
});
export const onConnect = spacetimedb.clientConnected((ctx) => voip.onConnect(ctx.as.voip));
export const onDisconnect = spacetimedb.clientDisconnected((ctx) => voip.onDisconnect(ctx.as.voip));

// In your movement reducer, for proximity rooms:
voip.setPosition(ctx.as.voip, ctx.sender, { x, y, z });
```

The library functions are `configure`, `newRoom`, `deleteRoom`, `joinRoom`, `leaveRoom`, `setPosition`,
`clearPosition`, `setServerMuted`, `onConnect` and `onDisconnect`. They match the Rust and C# versions.

## Names

Submodule tables and reducers are namespaced: `voip.packet`, `voip.peer`, reducer `voip.send`, and in generated client
bindings `conn.db['voip.packet']`, `conn.reducers['voip.send']`. Rust and C# use `voip_packet` / `voip_send`. Columns
and arguments are identical. [`demo/web/src/api.ts`](../demo/web/src/api.ts) shows one client handling both.
