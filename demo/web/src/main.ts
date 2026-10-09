// Demo web client: voice rooms plus a proximity "campfire" map.
// Served by the demo module at /route/, or open dist/index.html with ?host=ws://...&db=...
import { VoipClient, voipPacketQuery } from 'spacetimedb-voip-client';
import type { Identity } from 'spacetimedb';
import { connect, type Flavor, type Voice } from './api';

const MAP = 100;
// Inline icons (emoji fonts aren't everywhere, e.g. headless browsers and some Linux desktops).
const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  speaker: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  fire: svg('<path d="M12 22c4 0 7-2.7 7-7 0-4-3-6.5-4-10-2 2-2.5 4-2.5 5.5C11 9 10 7.5 10 6c-3 2.5-5 5.5-5 9 0 4.3 3 7 7 7z"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
};
const params = new URLSearchParams(location.search);
const routed = location.pathname.match(/\/v1\/database\/([^/]+)\/route/);
const HOST = params.get('host') ?? (routed ? location.origin.replace(/^http/, 'ws') : 'ws://127.0.0.1:3000');
const DB = params.get('db') ?? (routed ? decodeURIComponent(routed[1]) : 'voip');
const TOKEN_KEY = `voip-demo:${HOST}:${DB}`;
// Schema flavour: 'flat' (Rust, C#) or 'ns' (TypeScript submodule). The TS demo module
// serves this page with data-flavor="ns"; for a static copy, pass ?flavor=ns.
const FLAVOR = (params.get('flavor') ?? document.documentElement.dataset.flavor ?? 'flat') as Flavor;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

let myPeerId = 0;
let voip: VoipClient | null = null;
let micOn = false;
let packetSub = false;
const talking = new Set<number>();
const volumes = new Map<number, number>();

function token(): string | undefined {
  if (params.has('fresh')) return undefined;
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function status(text: string, ok = true) {
  const s = $('status');
  s.textContent = text;
  s.classList.toggle('bad', !ok);
}

function toast(text: string) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

async function call(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    toast(String((e as Error)?.message ?? e));
  }
}

// -- connection ----------------------------------------------------------------

let v: Voice;
try {
  v = await connect(FLAVOR, HOST, DB, token(), () => status('disconnected', false));
} catch (e) {
  status(`can't connect: ${e}`, false);
  throw e;
}
const me: Identity = v.identity;
if (params.has('test')) Object.assign(window, { __v: v });
try {
  localStorage.setItem(TOKEN_KEY, v.token);
} catch {}
status(`connected to ${DB}`);
v.conn
  .subscriptionBuilder()
  .onApplied(() => {
    render();
    subscribePackets();
  })
  .subscribe([`SELECT * FROM ${v.sql.room}`, `SELECT * FROM ${v.sql.peer}`, `SELECT * FROM ${v.sql.player}`]);

const myPeer = () => [...v.peer.iter()].find((p) => p.identity.isEqual(me));
const myPlayer = () => v.player.identity.find(me);
const myRoom = () => {
  const p = myPeer();
  return p && p.roomId ? v.room.id.find(p.roomId) : undefined;
};
const nameOf = (id: Identity) => v.player.identity.find(id)?.name ?? id.toHexString().slice(-6);

function subscribePackets() {
  const peer = myPeer();
  if (!peer || packetSub) return;
  myPeerId = peer.id;
  packetSub = true;
  v.conn.subscriptionBuilder().subscribe([voipPacketQuery(myPeerId, v.sql.packet)]);
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

v.room.onInsert(queueRender);
v.room.onDelete(queueRender);
v.room.onUpdate(queueRender);
v.peer.onInsert(queueRender);
v.peer.onUpdate(queueRender);
v.player.onInsert(queueRender);
v.player.onUpdate(queueRender);
v.player.onDelete(queueRender);
v.peer.onInsert(() => subscribePackets());
v.packet.onInsert((_ctx, p) => voip?.receive(p));

// Leaving peers: drop their decoders.
v.peer.onUpdate((_ctx, old, now) => {
  const room = myRoom();
  if (voip && old.roomId !== now.roomId && (!room || now.roomId !== room.id)) voip.removeSpeaker(now.id);
  if (now.identity.isEqual(me) && old.roomId !== now.roomId) roomChanged();
});

// -- voice ---------------------------------------------------------------------

function ensureVoip(): VoipClient {
  if (voip) return voip;
  voip = new VoipClient({
    send: (seq, flags, data) => v.send(seq, flags, data),
    frameMs: Number(params.get('frame') ?? 20) as 20,
    // ?raw=1: no echo cancellation / noise suppression / AGC (music, or test tones).
    ...(params.has('raw') ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : {}),
  });
  voip.onTalking = (id, on) => {
    on ? talking.add(id) : talking.delete(id);
    queueRender();
  };
  voip.onSending = (on) => {
    $('me-ring').classList.toggle('on', on);
    on ? talking.add(myPeerId) : talking.delete(myPeerId);
    queueRender();
  };
  voip.onMicLevel = (db) => {
    const pct = Math.max(0, Math.min(100, ((db + 80) / 80) * 100));
    $('meter-fill').style.width = `${pct}%`;
  };
  (window as any).__voip = voip;
  if (params.has('test')) {
    // e2e hooks: tap the mixed output per channel, and log send/receive times per packet.
    const split = voip.ctx.createChannelSplitter(2);
    voip.output.channelCount = 2;
    voip.output.channelCountMode = 'explicit';
    voip.output.connect(split);
    const analysers = [0, 1].map((ch) => {
      const a = voip!.ctx.createAnalyser();
      a.fftSize = 8192;
      split.connect(a, ch);
      return a;
    });
    const sent: Record<number, number> = {};
    const recv: Record<string, number> = {};
    const send = (voip as any).o.send;
    (voip as any).o.send = (seq: number, flags: number, data: Uint8Array) => {
      sent[seq] = performance.timeOrigin + performance.now();
      return send(seq, flags, data);
    };
    v.packet.onInsert((_c, p) => (recv[`${p.speaker}:${p.seq}`] = performance.timeOrigin + performance.now()));
    Object.assign(window, { __analysers: analysers, __sent: sent, __recv: recv, __peerId: () => myPeerId });
  }
  roomChanged();
  return voip;
}

function roomChanged() {
  const room = myRoom();
  if (!voip) return;
  voip.setSpatial(room?.spatial ? { range: room.range } : null);
  syncListener();
}

function syncListener() {
  const p = myPlayer();
  if (!voip || !p) return;
  voip.setListener({ x: p.x, y: p.y, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 });
}

async function toggleMic() {
  const v = ensureVoip();
  if (micOn) {
    v.stop();
    micOn = false;
  } else {
    try {
      await v.start();
      micOn = true;
    } catch (e) {
      toast(`mic: ${(e as Error).message}`);
    }
  }
  render();
}

// -- UI ------------------------------------------------------------------------

function render() {
  if (!me) return;
  const peer = myPeer();
  const room = myRoom();
  const player = myPlayer();
  $('my-name').textContent = player?.name ?? '…';

  // Rooms
  const list = $('rooms');
  list.replaceChildren();
  const rooms = [...v.room.iter()].sort((a, b) => Number(a.id - b.id));
  for (const r of rooms) {
    const members = [...v.peer.iter()].filter((p) => p.roomId === r.id && p.online);
    const li = el('button', 'room' + (room?.id === r.id ? ' active' : ''));
    const icon = el('span', 'room-icon');
    icon.innerHTML = r.locked ? ICONS.lock : r.spatial ? ICONS.fire : ICONS.speaker;
    li.append(icon, el('span', 'room-name', r.name));
    li.append(el('span', 'count', String(members.length)));
    li.onclick = () => {
      ensureVoip();
      void voip!.resume();
      call(v.join(r.id));
    };
    list.append(li);
    if (members.length) {
      const ul = el('div', 'room-members');
      for (const m of members) {
        const row = el('div', 'mini' + (talking.has(m.id) ? ' talking' : ''));
        row.append(el('span', 'dot'), el('span', '', nameOf(m.identity)));
        if (m.muted || m.serverMuted) row.append(el('span', 'tag', m.serverMuted ? 'server-muted' : 'muted'));
        if (m.deafened) row.append(el('span', 'tag', 'deaf'));
        ul.append(row);
      }
      list.append(ul);
    }
  }

  // Main panel
  $('room-title').textContent = room ? room.name : 'Pick a room';
  $('room-sub').textContent = room
    ? room.spatial
      ? `Proximity voice: you hear people within ${room.range} m. Click the map or use WASD to walk.`
      : 'Everyone in the room hears everyone.'
    : 'Join a room on the left. Your browser will ask for the microphone when you turn it on.';
  $('leave').toggleAttribute('hidden', !room);
  $('map-wrap').toggleAttribute('hidden', !room?.spatial);

  const grid = $('members');
  grid.replaceChildren();
  if (room) {
    const members = [...v.peer.iter()].filter((p) => p.roomId === room.id && p.online);
    for (const m of members) {
      const isMe = m.identity.isEqual(me);
      const card = el('div', 'card' + (talking.has(m.id) ? ' talking' : '') + (isMe ? ' me' : ''));
      const avatar = el('div', 'avatar', nameOf(m.identity).slice(0, 2).toUpperCase());
      card.append(avatar, el('div', 'card-name', nameOf(m.identity) + (isMe ? ' (you)' : '')));
      const tags = el('div', 'tags');
      if (m.muted) tags.append(el('span', 'tag', 'muted'));
      if (m.serverMuted) tags.append(el('span', 'tag warn', 'server-muted'));
      if (m.deafened) tags.append(el('span', 'tag', 'deafened'));
      card.append(tags);
      if (!isMe) {
        const vol = el('input') as HTMLInputElement;
        vol.type = 'range';
        vol.min = '0';
        vol.max = '2';
        vol.step = '0.05';
        vol.value = String(volumes.get(m.id) ?? 1);
        vol.title = 'Volume';
        vol.oninput = () => {
          volumes.set(m.id, Number(vol.value));
          voip?.setVolume(m.id, Number(vol.value));
        };
        card.append(vol);
        if (room.owner?.isEqual(me)) {
          const mod = el('button', 'small', m.serverMuted ? 'Unmute' : 'Server mute');
          mod.onclick = () => call(v.moderate(m.identity, !m.serverMuted));
          card.append(mod);
        }
      }
      grid.append(card);
    }
  }

  // Controls
  $('mic').textContent = micOn ? 'Mic on' : 'Turn mic on';
  $('mic').classList.toggle('on', micOn);
  $('mute').classList.toggle('on', !!peer?.muted);
  $('mute').textContent = peer?.muted ? 'Unmute' : 'Mute';
  $('deafen').classList.toggle('on', !!peer?.deafened);
  $('deafen').textContent = peer?.deafened ? 'Undeafen' : 'Deafen';

  if (room?.spatial) drawMap(room.range);
}
// -- map -------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('map');
function drawMap(range: number) {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== size * dpr) {
    canvas.width = canvas.height = size * dpr;
  }
  const g = canvas.getContext('2d')!;
  const s = (size * dpr) / MAP;
  const css = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = css.getPropertyValue('--grid');
  g.lineWidth = 1;
  for (let i = 0; i <= MAP; i += 10) {
    g.beginPath();
    g.moveTo(i * s, 0);
    g.lineTo(i * s, MAP * s);
    g.moveTo(0, i * s);
    g.lineTo(MAP * s, i * s);
    g.stroke();
  }
  // campfire: a warm glow and a few logs
  const glow = g.createRadialGradient(50 * s, 50 * s, 0, 50 * s, 50 * s, 6 * s);
  glow.addColorStop(0, 'rgba(255, 170, 60, 0.9)');
  glow.addColorStop(1, 'rgba(255, 120, 20, 0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(50 * s, 50 * s, 6 * s, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#8a5a2b';
  g.lineWidth = 0.9 * s;
  g.lineCap = 'round';
  for (const a of [0.4, 1.4, 2.6]) {
    g.beginPath();
    g.moveTo((50 - Math.cos(a) * 2.2) * s, (50 - Math.sin(a) * 2.2) * s);
    g.lineTo((50 + Math.cos(a) * 2.2) * s, (50 + Math.sin(a) * 2.2) * s);
    g.stroke();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const room = myRoom()!;
  const inRoom = new Set(
    [...v.peer.iter()].filter((p) => p.roomId === room.id && p.online).map((p) => p.identity.toHexString())
  );
  const peers = new Map([...v.peer.iter()].map((p) => [p.identity.toHexString(), p]));
  const mine = myPlayer();
  if (mine) {
    g.beginPath();
    g.arc(mine.x * s, mine.y * s, range * s, 0, Math.PI * 2);
    g.fillStyle = css.getPropertyValue('--range');
    g.fill();
  }
  for (const p of v.player.iter()) {
    const hex = p.identity.toHexString();
    if (!inRoom.has(hex)) continue;
    const peer = peers.get(hex)!;
    const isMe = p.identity.isEqual(me);
    const on = talking.has(peer.id);
    g.beginPath();
    g.arc(p.x * s, p.y * s, (on ? 2.6 : 1.8) * s, 0, Math.PI * 2);
    g.fillStyle = isMe ? css.getPropertyValue('--accent') : on ? css.getPropertyValue('--talk') : css.getPropertyValue('--dot');
    g.fill();
    if (on) {
      g.strokeStyle = css.getPropertyValue('--talk');
      g.lineWidth = 0.5 * s;
      g.beginPath();
      g.arc(p.x * s, p.y * s, 3.6 * s, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = css.getPropertyValue('--fg');
    g.font = `${2.4 * s}px system-ui`;
    g.fillText(p.name, p.x * s, p.y * s - 4.5 * s);
  }
}

let pendingMove: { x: number; y: number } | null = null;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
function moveTo(x: number, y: number) {
  x = Math.max(0, Math.min(MAP, x));
  y = Math.max(0, Math.min(MAP, y));
  pendingMove = { x, y };
  if (voip) voip.setListener({ x, y, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 });
  if (moveTimer) return;
  const flush = () => {
    moveTimer = null;
    if (!pendingMove) return;
    const m = pendingMove;
    pendingMove = null;
    call(v.move(m.x, m.y));
    moveTimer = setTimeout(flush, 100); // at most 10 moves/s
  };
  flush();
}
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  moveTo(((e.clientX - r.left) / r.width) * MAP, ((e.clientY - r.top) / r.height) * MAP);
});
const keys = new Set<string>();
setInterval(() => {
  const room = myRoom();
  const p = myPlayer();
  if (!room?.spatial || !p || !keys.size) return;
  const dx = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
  const dy = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
  if (dx || dy) moveTo((pendingMove?.x ?? p.x) + dx * 1.5, (pendingMove?.y ?? p.y) + dy * 1.5);
}, 50);

v.player.onUpdate((_ctx, _old, now) => {
  if (now.identity.isEqual(me)) syncListener();
});

// -- controls --------------------------------------------------------------------

$('mic').onclick = () => void toggleMic();
$('mute').onclick = () => {
  const muted = !myPeer()?.muted;
  voip?.setMuted(muted);
  call(v.setMuted(muted));
};
$('deafen').onclick = () => call(v.setDeafened(!myPeer()?.deafened));
$('leave').onclick = () => call(v.leave());
$<HTMLSelectElement>('mode').onchange = (e) => {
  const mode = (e.target as HTMLSelectElement).value as 'voice' | 'ptt';
  ensureVoip().setMode(mode);
  $('ptt-hint').toggleAttribute('hidden', mode !== 'ptt');
};
$<HTMLInputElement>('gate').oninput = (e) => {
  const db = Number((e.target as HTMLInputElement).value);
  ensureVoip().setGateDb(db);
  $('gate-mark').style.left = `${((db + 80) / 80) * 100}%`;
};
$('new-room').onsubmit = (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>('new-name').value;
  const spatial = $<HTMLInputElement>('new-spatial').checked;
  ensureVoip();
  call(v.createRoom(name, spatial, 30));
  $<HTMLInputElement>('new-name').value = '';
};
$('my-name').onclick = () => {
  const name = prompt('Your name', myPlayer()?.name ?? '');
  if (name) call(v.setName(name));
};
const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    voip?.setPushToTalk(true);
  }
  keys.add(e.key.toLowerCase());
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') voip?.setPushToTalk(false);
  keys.delete(e.key.toLowerCase());
});
addEventListener('resize', queueRender);

setInterval(() => {
  if (!voip) return;
  const s = voip.stats;
  $('stats').textContent = `sent ${s.sentPackets} pkts (${(s.sentBytes / 1024).toFixed(1)} KB) · received ${s.receivedPackets} pkts (${(s.receivedBytes / 1024).toFixed(1)} KB) · underruns ${s.underruns}`;
}, 500);
