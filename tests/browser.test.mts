// End-to-end audio tests: real headless Chromium tabs with fake microphones playing test
// tones, talking through a published voice module.
//
//   PAGE=http://127.0.0.1:3000/v1/database/voip/route/ npx tsx tests/browser.test.mts
//
// PAGE can also be a static copy of demo/web/dist/index.html with ?host=...&db=...
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const PAGE = process.env.PAGE ?? 'http://127.0.0.1:3000/v1/database/voip/route/';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'voip-e2e-'));

/** 16-bit mono 48 kHz WAV: a sine at `hz` (0 = silence). */
function wav(name: string, hz: number, secs = 20, amp = 0.3): string {
  const n = 48000 * secs;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(48000, 24);
  buf.writeUInt32LE(96000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 48000) * amp * 32767), 44 + i * 2);
  const path = join(dir, name);
  writeFileSync(path, buf);
  return path;
}

const browsers: Browser[] = [];
async function open(micFile: string): Promise<Page> {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${micFile}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  browsers.push(browser);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  const sep = PAGE.includes('?') ? '&' : '?';
  await page.goto(`${PAGE}${sep}test=1&fresh=1&raw=1`);
  await page.waitForFunction(() => document.querySelectorAll('.room').length >= 2, null, { timeout: 15000 });
  await page.waitForFunction(() => (window as any).__peerId?.() > 0 || document.querySelector('#status')?.textContent?.startsWith('connected'));
  return page;
}

async function joinRoom(page: Page, room: string) {
  await page.locator('.room', { hasText: room }).click();
  await page.waitForFunction((r) => document.querySelector('#room-title')?.textContent === r, room);
}

/** Dominant frequency and level (dBFS) per output channel, averaged over a few reads. */
async function listen(page: Page): Promise<{ hz: number; db: number; left: number; right: number }> {
  return page.evaluate(async () => {
    const [l, r] = (window as any).__analysers as AnalyserNode[];
    const bins = new Float32Array(l.frequencyBinCount);
    const td = new Float32Array(l.fftSize);
    const sum = new Float32Array(l.frequencyBinCount);
    let el = 0;
    let er = 0;
    for (let k = 0; k < 10; k++) {
      await new Promise((res) => setTimeout(res, 100));
      l.getFloatFrequencyData(bins);
      for (let i = 0; i < bins.length; i++) sum[i] += Math.pow(10, bins[i] / 10);
      r.getFloatFrequencyData(bins);
      for (let i = 0; i < bins.length; i++) sum[i] += Math.pow(10, bins[i] / 10);
      l.getFloatTimeDomainData(td);
      for (const v of td) el += v * v;
      r.getFloatTimeDomainData(td);
      for (const v of td) er += v * v;
    }
    let best = 0;
    for (let i = 1; i < sum.length; i++) if (sum[i] > sum[best]) best = i;
    // (no helper functions in here: tsx's keepNames would inject an undefined __name)
    const n = 10 * l.fftSize;
    return {
      hz: (best * l.context.sampleRate) / l.fftSize,
      db: 10 * Math.log10((el + er) / 2 / n + 1e-12),
      left: 10 * Math.log10(el / n + 1e-12),
      right: 10 * Math.log10(er / n + 1e-12),
    };
  });
}

const move = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => (window as any).__v.move(x, y), [x, y]);

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const tone = wav('tone440.wav', 440);
const silence = wav('silence.wav', 0);
const speaker = await open(tone);
const listener = await open(silence);
const quiet = await open(silence);

try {
  await test('room: the listener hears the speaker\'s 440 Hz tone', async () => {
    await joinRoom(listener, 'Lobby');
    await joinRoom(speaker, 'Lobby');
    await speaker.locator('#mic').click();
    await sleep(2500);
    const heard = await listen(listener);
    assert.ok(Math.abs(heard.hz - 440) < 15, `dominant ${heard.hz.toFixed(0)} Hz`);
    assert.ok(heard.db > -30, `level ${heard.db.toFixed(1)} dBFS`);
    await listener.waitForSelector('.card.talking', { timeout: 2000 });
    console.log(`      heard ${heard.hz.toFixed(0)} Hz at ${heard.db.toFixed(1)} dBFS`);
  });

  await test('noise gate: a silent mic sends nothing', async () => {
    await joinRoom(quiet, 'Lobby');
    await quiet.locator('#mic').click();
    await sleep(1500);
    const sent = await quiet.evaluate(() => (window as any).__voip.stats.sentPackets);
    assert.equal(sent, 0);
  });

  await test('latency: send → receive per packet, and playback stays smooth', async () => {
    const sent: Record<string, number> = await speaker.evaluate(() => (window as any).__sent);
    const recv: Record<string, number> = await listener.evaluate(() => (window as any).__recv);
    const id = await speaker.evaluate(() => (window as any).__peerId());
    const d = Object.entries(sent)
      .map(([seq, t]) => recv[`${id}:${seq}`] - t)
      .filter((x) => Number.isFinite(x))
      .sort((a, b) => a - b);
    assert.ok(d.length > 50, `${d.length} packets matched`);
    const p = (q: number) => d[Math.floor(q * (d.length - 1))].toFixed(1);
    console.log(`      ${d.length} packets: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${p(1)} ms`);
    const stats = await listener.evaluate(() => (window as any).__voip.stats);
    const s = await speaker.evaluate(() => (window as any).__voip.stats);
    console.log(`      speaker sent ${s.sentPackets} pkts / ${s.sentBytes} B (rejected ${s.rejected}); listener underruns ${stats.underruns}`);
    assert.ok(Number(p(0.5)) < 100);
    assert.equal(s.rejected, 0);
  });

  await test('mute: the listener goes quiet', async () => {
    await speaker.locator('#mute').click();
    await sleep(1500);
    const heard = await listen(listener);
    assert.ok(heard.db < -60, `level ${heard.db.toFixed(1)} dBFS`);
    await speaker.locator('#mute').click();
  });

  await test('proximity: louder when near, silent when far, panned to the side the speaker is on', async () => {
    await move(listener, 50, 50);
    await move(speaker, 60, 50);
    await joinRoom(listener, 'Campfire');
    await joinRoom(speaker, 'Campfire');
    await sleep(2500);
    const right = await listen(listener);
    assert.ok(Math.abs(right.hz - 440) < 15, `dominant ${right.hz.toFixed(0)} Hz`);
    assert.ok(right.right > right.left + 3, `right ${right.right.toFixed(1)} vs left ${right.left.toFixed(1)}`);
    await move(speaker, 40, 50);
    await sleep(1500);
    const left = await listen(listener);
    assert.ok(left.left > left.right + 3, `left ${left.left.toFixed(1)} vs right ${left.right.toFixed(1)}`);
    await move(speaker, 50, 75);
    await sleep(1500);
    const far = await listen(listener);
    assert.ok(far.db < right.db - 6, `25 m ${far.db.toFixed(1)} dB vs 10 m ${right.db.toFixed(1)} dB`);
    await move(speaker, 50, 99);
    await sleep(1500);
    const gone = await listen(listener);
    assert.ok(gone.db < -60, `out of range: ${gone.db.toFixed(1)} dBFS`);
    console.log(`      10 m: ${right.db.toFixed(1)} dB (R ${right.right.toFixed(1)} / L ${right.left.toFixed(1)}), 25 m: ${far.db.toFixed(1)} dB, 49 m: ${gone.db.toFixed(1)} dB`);
  });
} finally {
  for (const b of browsers) await b.close();
}
console.log(`\n${passed} passed`);
