# spacetimedb-voip for TypeScript (submodule)

Voice chat as a **Spacetime submodule**. Mount it, and your module gets rooms, proximity voice and private
packet delivery.

Source: [`src/index.ts`](src/index.ts) · Complete example: [`demo/typescript`](../demo/typescript/src/index.ts) ·
Protocol: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md)

## Install

```bash
npm install @pogly/spacetimedb-voip spacetimedb
```

Use `spacetimedb` 2.13.x or 2.14.x, and keep only one copy of it in your module's dependency tree. With two copies,
`spacetime publish` fails with *"Local module schema inspection failed"*. The package ships compiled JavaScript plus
its TypeScript source, which is where the types come from.

A module built with the 2.14 library needs a 2.14 or newer host: the library's HTTP handler export changed, and older
hosts reject it ([release notes](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.14.0)). If your host is still on 2.13, stay on `spacetimedb` 2.13.x.

To work on it from a clone instead, add this folder to your npm workspaces next to your module:

```jsonc
// package.json at your repo root
{ "private": true, "workspaces": ["spacetimedb-voip/typescript", "my-module"] }
// my-module/package.json
{ "dependencies": { "spacetimedb": "2.14.*", "@pogly/spacetimedb-voip": "*" } }
```

## Wire it up

Submodules can't declare row-level-security filters or lifecycle reducers, so your module adds them:

```typescript
import { schema } from 'spacetimedb/server';
import * as voip from '@pogly/spacetimedb-voip';                // `import * as`, not a default import

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
