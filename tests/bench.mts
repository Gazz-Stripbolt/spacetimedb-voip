// Load test: S speakers and L listeners in one room, each speaker sending one 20 ms frame
// (60 bytes, roughly 24 kbit/s Opus) every 20 ms. Reports delivery, latency, and wire bytes.
//
//   DB=voip-rust SPEAKERS=10 LISTENERS=20 SECS=10 npx tsx tests/bench.mts
import { connect, type Flavor, type Voice } from '../demo/web/src/api.ts';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'voip-rust';
const FLAVOR = (process.env.FLAVOR ?? 'flat') as Flavor;
const SPEAKERS = Number(process.env.SPEAKERS ?? 10);
const LISTENERS = Number(process.env.LISTENERS ?? 20);
const SECS = Number(process.env.SECS ?? 10);
const FRAME = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Count bytes on the wire (after compression, as the server sent them).
let wireIn = 0;
const Native = globalThis.WebSocket;
globalThis.WebSocket = class extends Native {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener('message', (e: MessageEvent) => {
      const d = e.data;
      wireIn += typeof d === 'string' ? d.length : d instanceof ArrayBuffer ? d.byteLength : (d as Blob).size;
    });
  }
} as typeof WebSocket;

const lat: number[] = [];
let delivered = 0;
async function client(listen: boolean): Promise<{ v: Voice; id: number }> {
  const v = await connect(FLAVOR, HOST, DB);
  await new Promise<void>((res) =>
    v.conn.subscriptionBuilder().onApplied(() => res()).subscribe([`SELECT * FROM ${v.sql.peer}`, `SELECT * FROM ${v.sql.room}`])
  );
  const id = [...v.peer.iter()].find((p) => p.identity.isEqual(v.identity))!.id;
  if (listen) {
    v.packet.onInsert((_c, p) => {
      delivered++;
      const sent = new DataView(p.data.buffer, p.data.byteOffset, 8).getFloat64(0);
      lat.push(performance.timeOrigin + performance.now() - sent);
    });
    await new Promise<void>((res) =>
      v.conn.subscriptionBuilder().onApplied(() => res()).subscribe([`SELECT * FROM ${v.sql.packet} WHERE speaker != ${id}`])
    );
  }
  return { v, id };
}

const speakers = await Promise.all(Array.from({ length: SPEAKERS }, () => client(false)));
const listeners = await Promise.all(Array.from({ length: LISTENERS }, () => client(true)));
const lobby = [...speakers[0].v.room.iter()].find((r) => r.name === 'Lobby')!.id;
for (const c of [...speakers, ...listeners]) await c.v.join(lobby);
await sleep(500);
delivered = 0;
lat.length = 0;
const wireStart = wireIn;

let sent = 0;
let rejected = 0;
const t0 = performance.now();
const timers = speakers.map(({ v }, i) => {
  let seq = 0;
  const tick = () => {
    const data = new Uint8Array(FRAME);
    new DataView(data.buffer).setFloat64(0, performance.timeOrigin + performance.now());
    sent++;
    v.send(seq++, 0, data).catch(() => rejected++);
  };
  return setTimeout(() => (timers[i] = setInterval(tick, 20) as any), (i * 20) / SPEAKERS) as any;
});
await sleep(SECS * 1000);
timers.forEach((t) => clearInterval(t));
await sleep(500);
const secs = (performance.now() - t0) / 1000;

lat.sort((a, b) => a - b);
const p = (q: number) => (lat.length ? lat[Math.floor(q * (lat.length - 1))].toFixed(1) : '-');
const expected = (sent - rejected) * LISTENERS;
console.log(`${DB}: ${SPEAKERS} speakers -> ${LISTENERS} listeners, ${secs.toFixed(1)} s`);
console.log(`  reducer calls  ${(sent / secs).toFixed(0)}/s, rejected ${rejected}`);
console.log(`  delivered      ${delivered}/${expected} (${((100 * delivered) / Math.max(1, expected)).toFixed(1)}%)`);
console.log(`  latency        p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, p99 ${p(0.99)} ms, max ${p(1)} ms`);
console.log(`  wire, per listener  ${((wireIn - wireStart) / LISTENERS / secs / 1024).toFixed(1)} KB/s, ${((wireIn - wireStart) / Math.max(1, delivered)).toFixed(0)} B per delivered ${FRAME} B frame`);
for (const c of [...speakers, ...listeners]) c.v.conn.disconnect();
process.exit(0);
