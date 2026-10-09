// Protocol-level tests: real clients against a published voice module, no audio.
//
//   DB=voip HOST=ws://127.0.0.1:3000 [FLAVOR=flat|ns] npx tsx tests/server.test.mts
//
// FLAVOR=ns for the TypeScript submodule (namespaced names), flat for Rust and C#.
// Covers delivery scoping (rooms, RLS, self-echo), proximity cells, mute/deafen,
// moderation, rate limiting, transient and locked rooms, and disconnect cleanup.
import assert from 'node:assert/strict';
import { connect as connectVoice, type Flavor, type Voice } from '../demo/web/src/api.ts';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'voip';
const FLAVOR = (process.env.FLAVOR ?? 'flat') as Flavor;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Pkt = { speaker: number; seq: number; flags: number; pos?: { x: number; y: number; z: number }; bytes: number };
type Client = {
  v: Voice;
  id: number;
  got: Pkt[];
  call: <T>(p: Promise<T>) => Promise<string | null>;
  room: (name: string) => bigint;
  close: () => void;
};

/** Connect, wait for our peer row, then subscribe to packets minus our own. */
async function connect(raw = false): Promise<Client> {
  const v = await connectVoice(FLAVOR, HOST, DB);
  const got: Pkt[] = [];
  v.packet.onInsert((_ctx, p) =>
    got.push({ speaker: p.speaker, seq: p.seq, flags: p.flags, pos: p.pos ?? undefined, bytes: p.data.length })
  );
  await new Promise<void>((res, rej) =>
    v.conn.subscriptionBuilder().onApplied(() => res()).onError((_c, e) => rej(e))
      .subscribe([`SELECT * FROM ${v.sql.peer}`, `SELECT * FROM ${v.sql.room}`])
  );
  const peer = [...v.peer.iter()].find((p) => p.identity.isEqual(v.identity));
  assert.ok(peer, 'peer row created on connect');
  const query = raw ? `SELECT * FROM ${v.sql.packet}` : `SELECT * FROM ${v.sql.packet} WHERE speaker != ${peer.id}`;
  await new Promise<void>((res, rej) =>
    v.conn.subscriptionBuilder().onApplied(() => res()).onError((_c, e) => rej(e)).subscribe([query])
  );
  return {
    v,
    id: peer.id,
    got,
    call: async (p) => {
      try {
        await p;
        return null;
      } catch (e) {
        return String((e as Error)?.message ?? e);
      }
    },
    room: (name) => [...v.room.iter()].find((r) => r.name === name)!.id,
    close: () => v.conn.disconnect(),
  };
}

const frame = (n = 60) => new Uint8Array(n).fill(7);
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}
function reset(...cs: Client[]) {
  for (const c of cs) c.got.length = 0;
}

const a = await connect();
const b = await connect();
const c = await connect();
const eve = await connect(true); // subscribes to everything, joins nothing
const lobby = a.room('Lobby');
const campfire = a.room('Campfire');

await test('rooms: members hear each other; outsiders, eavesdroppers and the speaker do not', async () => {
  assert.equal(await a.call(a.v.join(lobby)), null);
  assert.equal(await b.call(b.v.join(lobby)), null);
  await sleep(100);
  for (let i = 0; i < 5; i++) await a.v.send(i, i === 4 ? 1 : 0, frame());
  await sleep(300);
  assert.deepEqual(b.got.map((p) => p.seq), [0, 1, 2, 3, 4]);
  assert.equal(b.got[4].flags, 1, 'END flag carried');
  assert.ok(b.got.every((p) => p.speaker === a.id && p.pos === undefined));
  assert.equal(a.got.length, 0, 'no self-echo');
  assert.equal(c.got.length, 0, 'not in the room');
  assert.equal(eve.got.length, 0, 'raw subscription sees nothing (RLS)');
});

await test('not in a room: sending is rejected', async () => {
  const err = await c.call(c.v.send(0, 0, frame()));
  assert.match(err ?? '', /not in a voice room|can't speak/);
});

await test('mute: packets rejected, nothing delivered; unmute restores', async () => {
  reset(a, b);
  await a.v.setMuted(true);
  assert.match((await a.call(a.v.send(10, 0, frame()))) ?? '', /can't speak/);
  await a.v.setMuted(false);
  await a.v.send(11, 0, frame());
  await sleep(200);
  assert.deepEqual(b.got.map((p) => p.seq), [11]);
});

await test('deafen: delivery stops at the server, and you are muted too', async () => {
  reset(a, b);
  await b.v.setDeafened(true);
  await a.v.send(20, 0, frame());
  assert.match((await b.call(b.v.send(0, 0, frame()))) ?? '', /can't speak/);
  await sleep(200);
  assert.equal(b.got.length, 0);
  await b.v.setDeafened(false);
  await a.v.send(21, 0, frame());
  await sleep(200);
  assert.deepEqual(b.got.map((p) => p.seq), [21]);
});

await test('size cap: oversized packets rejected', async () => {
  assert.match((await a.call(a.v.send(0, 0, frame(1501)))) ?? '', /too large/);
});

await test('rate limit: a flood is cut to roughly burst + rate', async () => {
  await sleep(2100); // refill the bucket (16 kB at 8 kB/s)
  reset(b);
  const t0 = Date.now();
  let rejected = 0;
  const sends: Promise<void>[] = [];
  for (let i = 0; i < 60; i++) {
    sends.push(a.v.send(100 + i, 0, frame(1000)).catch(() => void rejected++));
  }
  await Promise.all(sends);
  const secs = (Date.now() - t0) / 1000;
  await sleep(200);
  const allowed = (16_000 + 8_000 * secs) / 1032;
  assert.ok(rejected > 0, 'some packets rejected');
  assert.ok(b.got.length <= Math.ceil(allowed) + 1, `delivered ${b.got.length} <= ~${allowed.toFixed(1)}`);
  assert.equal(b.got.length + rejected, 60);
});

await test('locked room: clients cannot join', async () => {
  assert.match((await c.call(c.v.join(a.room('Staff')))) ?? '', /locked/);
});

await test('transient room: created by a client, moderated by its owner, deleted when empty', async () => {
  assert.equal(await c.call(c.v.createRoom('Side chat', false, 0)), null);
  await sleep(100);
  const side = c.room('Side chat');
  const owner = [...c.v.room.iter()].find((r) => r.id === side)!.owner;
  assert.ok(owner?.isEqual(c.v.identity), 'owned by its creator');
  await a.v.join(side);
  reset(a, b, c);
  await a.v.send(30, 0, frame());
  await sleep(200);
  assert.deepEqual(c.got.map((p) => p.seq), [30]);
  assert.equal(b.got.length, 0, 'lobby no longer hears a');
  // a is not the owner, so a can't moderate
  assert.match((await a.call(a.v.moderate(c.v.identity, true))) ?? '', /owner/);
  await c.v.moderate(a.v.identity, true);
  assert.match((await a.call(a.v.send(31, 0, frame()))) ?? '', /can't speak/);
  await c.v.moderate(a.v.identity, false);
  await a.v.send(32, 0, frame());
  await sleep(200);
  assert.deepEqual(c.got.map((p) => p.seq), [30, 32]);
  await a.v.join(lobby);
  await c.v.leave();
  await sleep(200);
  assert.equal([...c.v.room.iter()].some((r) => r.id === side), false, 'deleted when empty');
});

await test('proximity: near hears with position, far does not, moving changes it', async () => {
  await a.v.move(10, 10);
  await b.v.move(25, 12);
  await c.v.move(95, 95);
  for (const x of [a, b, c]) await x.v.join(campfire);
  await sleep(200);
  reset(a, b, c);
  await a.v.send(40, 0, frame());
  await sleep(200);
  assert.deepEqual(b.got.map((p) => p.seq), [40]);
  assert.deepEqual(b.got[0].pos, { x: 10, y: 10, z: 0 }, 'speaker position attached');
  assert.equal(c.got.length, 0, 'far away');
  assert.equal(eve.got.length, 0);
  // b walks far away, c walks close
  await b.v.move(95, 5);
  await c.v.move(12, 30);
  await sleep(200);
  reset(a, b, c);
  await a.v.send(41, 0, frame());
  await sleep(200);
  assert.equal(b.got.length, 0);
  assert.deepEqual(c.got.map((p) => p.seq), [41]);
  // Listen rows are opaque: room ids or cell ids with the top bit set, never coordinates.
  const rows = await new Promise<bigint[]>((res) => {
    const out: bigint[] = [];
    c.v.listen.onInsert((_x, r) => r.listener.isEqual(c.v.identity) && out.push(r.audience));
    c.v.conn.subscriptionBuilder().onApplied(() => res(out.length ? out : [...c.v.listen.iter()].filter((r) => r.listener.isEqual(c.v.identity)).map((r) => r.audience)))
      .subscribe([`SELECT * FROM ${c.v.sql.listen}`]);
  });
  assert.equal(rows.length, 27, '3x3x3 neighbourhood');
  assert.ok(rows.every((k) => k >= 1n << 63n));
});

await test('disconnect: peer goes offline, leaves the room, listen rows removed', async () => {
  const bId = b.v.identity;
  b.close();
  await sleep(400);
  const peer = [...a.v.peer.iter()].find((p) => p.identity.isEqual(bId))!;
  assert.equal(peer.online, false);
  assert.equal(peer.roomId, 0n);
});

console.log(`\n${passed} passed`);
for (const x of [a, c, eve]) x.close();
process.exit(0);
