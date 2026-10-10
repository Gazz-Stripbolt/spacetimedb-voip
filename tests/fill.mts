// Pushes a database's transaction count up quickly (cheap `demo_move` calls from C clients, W in flight each),
// e.g. to get close to a snapshot (SpacetimeDB snapshots every 1,000,000 transactions) before a measured run.
//
//   HOST=ws://127.0.0.1:3300 DB=voip-rust TXS=990000 CLIENTS=4 WINDOW=64 npx tsx tests/fill.mts
import { connect, type Flavor } from '../demo/web/src/api.ts';

const HOST = process.env.HOST ?? 'ws://127.0.0.1:3000';
const DB = process.env.DB ?? 'voip-rust';
const FLAVOR = (process.env.FLAVOR ?? 'flat') as Flavor;
const TXS = Number(process.env.TXS ?? 100_000);
const CLIENTS = Number(process.env.CLIENTS ?? 4);
const WINDOW = Number(process.env.WINDOW ?? 64);

let done = 0;
let issued = 0;
const t0 = performance.now();
const progress = setInterval(() => {
  const s = (performance.now() - t0) / 1000;
  console.log(`${done} txs, ${Math.round(done / s)}/s`);
}, 10_000);

async function worker(c: number) {
  const v = await connect(FLAVOR, HOST, DB);
  let x = 0;
  const lane = async () => {
    while (issued < TXS) {
      issued++;
      x++;
      await v.move(1 + (x % 97), 1 + ((x * 7 + c) % 89)); // always a real change, so every call commits
      done++;
    }
  };
  await Promise.all(Array.from({ length: WINDOW }, lane));
  v.conn.disconnect();
}

await Promise.all(Array.from({ length: CLIENTS }, (_, c) => worker(c)));
clearInterval(progress);
const s = (performance.now() - t0) / 1000;
console.log(`done: ${done} txs in ${s.toFixed(1)} s (${Math.round(done / s)}/s)`);
process.exit(0);
