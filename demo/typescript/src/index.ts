/**
 * Demo: voice rooms plus a proximity "campfire", in TypeScript, using `spacetimedb-voip` as a
 * submodule. Same behaviour as demo/rust and demo/csharp; serves the web client at /route/.
 */
import { schema, table, t, Router, SyncResponse, SenderError, type ReducerCtx } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import * as voip from 'spacetimedb-voip';
import PAGE from './page.gen';

/** The campfire map is 0..MAP x 0..MAP. */
const MAP = 100;

const demoPlayer = table(
  { name: 'demo_player', public: true },
  { identity: t.identity().primaryKey(), name: t.string(), x: t.f32(), y: t.f32() }
);

const spacetimedb = schema({ demoPlayer, voip });
export default spacetimedb;

// ---------------------------------------------------------------------------
// voip wiring: lifecycle hooks and the delivery rule (submodules can't declare either)
// ---------------------------------------------------------------------------

export const voipPacketFilter = spacetimedb.clientVisibilityFilter.sql(voip.packetFilterSql('voip'));

export const init = spacetimedb.init((ctx) => {
  voip.configure(ctx.as.voip, voip.DEFAULT_SETTINGS);
  voip.newRoom(ctx.as.voip, 'Lobby');
  voip.newRoom(ctx.as.voip, 'Campfire', { spatial: true, range: 30 });
  // Locked: only module code can put people here (see voip.joinRoom). The demo never does.
  voip.newRoom(ctx.as.voip, 'Staff', { locked: true });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  voip.onConnect(ctx.as.voip);
  if (!ctx.db.demoPlayer.identity.find(ctx.sender)) {
    const tail = ctx.sender.toHexString().slice(-4);
    // Spread newcomers around the middle of the map, deterministically.
    const seed = parseInt(tail, 16);
    ctx.db.demoPlayer.insert({ identity: ctx.sender, name: `guest-${tail}`, x: 35 + (seed % 30), y: 35 + (Math.floor(seed / 30) % 30) });
  }
  syncPosition(ctx, ctx.sender);
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => voip.onDisconnect(ctx.as.voip));

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

type Ctx = ReducerCtx<typeof spacetimedb.schemaType>;

export const demoSetName = spacetimedb.reducer({ name: t.string() }, (ctx, { name }) => {
  name = name.trim();
  if (name.length === 0 || [...name].length > 24) throw new SenderError('name must be 1-24 characters');
  const p = ctx.db.demoPlayer.identity.find(ctx.sender);
  if (!p) throw new SenderError('not connected');
  ctx.db.demoPlayer.identity.update({ ...p, name });
});

/** Move on the campfire map. The module, not the client, tells voip where you are. */
export const demoMove = spacetimedb.reducer({ x: t.f32(), y: t.f32() }, (ctx, { x, y }) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new SenderError('bad position');
  const p = ctx.db.demoPlayer.identity.find(ctx.sender);
  if (!p) throw new SenderError('not connected');
  ctx.db.demoPlayer.identity.update({ ...p, x: Math.max(0, Math.min(MAP, x)), y: Math.max(0, Math.min(MAP, y)) });
  syncPosition(ctx, ctx.sender);
});

function syncPosition(ctx: Ctx, who: Identity) {
  const p = ctx.db.demoPlayer.identity.find(who);
  if (p) voip.setPosition(ctx.as.voip, who, { x: p.x, y: p.y, z: 0 });
}

// The shared web client, told that this module uses the submodule's namespaced names.
const NS_PAGE = PAGE.replace('data-flavor="flat"', 'data-flavor="ns"');
export const page = spacetimedb.httpHandler(
  () => new SyncResponse(NS_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } })
);
export const router = spacetimedb.httpRouter(new Router().get('/', page));
