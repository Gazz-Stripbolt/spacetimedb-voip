/**
 * # spacetimedb-voip-client: browser voice client for spacetimedb-voip
 *
 * Mic → noise gate / push-to-talk → Opus (WebCodecs) → your `voip_send` reducer, and
 * `voip_packet` rows → per-speaker Opus decoder → adaptive jitter buffer → speakers, with
 * optional 3D panning and distance fade for proximity rooms.
 *
 * Not tied to your generated bindings: you hand it a `send` function and feed it packets.
 *
 * ```ts
 * const voip = new VoipClient({ send: (seq, flags, data) => conn.reducers.voipSend({ seq, flags, data }) });
 * conn.db.voipPacket.onInsert((_ctx, p) => voip.receive(p));
 * conn.subscriptionBuilder().subscribe([voipPacketQuery(myPeerId)]);
 * await voip.start();   // from a click: browsers only allow audio after a user gesture
 * ```
 */
import { workletUrl } from './worklets.js';

export const VOIP_FLAG_END = 1;

export type Vec3 = { x: number; y: number; z: number };

/** A `voip_packet` row as the generated bindings deliver it. */
export interface VoipPacketRow {
  speaker: number;
  seq: number;
  flags: number;
  pos?: Vec3 | null;
  data: Uint8Array;
}

export interface VoipClientOptions {
  /** Call your module's `voip_send` reducer. Rejections (rate limit, muted) are ignored. */
  send: (seq: number, flags: number, data: Uint8Array) => unknown;
  /** Opus frame length. Longer frames mean fewer reducer calls but more latency. Default 20. */
  frameMs?: 10 | 20 | 40 | 60;
  /** Opus bitrate in bit/s. Default 24000. */
  bitrate?: number;
  /** 'voice': send while the noise gate is open. 'ptt': send while `setPushToTalk(true)`. */
  mode?: 'voice' | 'ptt';
  /** Noise gate threshold in dBFS. Default -50. */
  gateDb?: number;
  /** Keep sending this long after the level drops below the gate. Default 300. */
  hangoverMs?: number;
  /** Frames sent from just before the gate opened, so first syllables aren't clipped. Default 2. */
  prerollFrames?: number;
  /** Jitter buffer bounds and starting point, in ms. Defaults 40 / 400 / 80. */
  jitter?: { minMs?: number; maxMs?: number; startMs?: number };
  /** Passed to getUserMedia. All default to true. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** A speaker is "talking" until this long after their last packet. Default 250. */
  talkTimeoutMs?: number;
}

export interface SpatialOptions {
  /** Distance at which a voice has faded to silence (the room's `range`). */
  range: number;
  /** Full volume up to this distance. Default range * 0.15. */
  refDistance?: number;
  /** 'HRTF' sounds best on headphones; 'equalpower' is cheaper. Default 'HRTF'. */
  panningModel?: PanningModelType;
}

export interface VoipStats {
  sentPackets: number;
  sentBytes: number;
  rejected: number;
  receivedPackets: number;
  receivedBytes: number;
  underruns: number;
}

type Remote = {
  decoder: AudioDecoder;
  node: AudioWorkletNode;
  gain: GainNode;
  panner?: PannerNode;
  volume: number;
  talking: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ts: number;
  ends: Set<number>;
  level: number;
};

/** Subscription query for packets, minus your own (pass your `voip_peer.id`). */
export function voipPacketQuery(selfId: number, table = 'voip_packet'): string {
  return `SELECT * FROM ${table} WHERE speaker != ${selfId}`;
}

export class VoipClient {
  readonly stats: VoipStats = { sentPackets: 0, sentBytes: 0, rejected: 0, receivedPackets: 0, receivedBytes: 0, underruns: 0 };
  /** Fires when someone starts or stops talking (speaker = their `voip_peer.id`). */
  onTalking: (speaker: number, talking: boolean) => void = () => {};
  /** Fires when your own sending starts or stops. */
  onSending: (sending: boolean) => void = () => {};
  /** Your mic level in dBFS, once per frame. */
  onMicLevel: (db: number) => void = () => {};

  readonly ctx: AudioContext;
  private o: Required<Omit<VoipClientOptions, 'jitter'>> & { jitter: Required<NonNullable<VoipClientOptions['jitter']>> };
  private ready: Promise<void>;
  private loaded = false;
  /** The mixed remote audio, before the speakers. Tap it for meters or recording. */
  readonly output: GainNode;
  private remotes = new Map<number, Remote>();
  private spatial: SpatialOptions | null = null;

  private mic?: MediaStream;
  private micNode?: AudioWorkletNode;
  private micSource?: MediaStreamAudioSourceNode;
  private encoder?: AudioEncoder;
  private encodeTs = 0;
  private gate = new Map<number, 'open' | 'end' | 'closed'>();
  private preroll: Uint8Array[] = [];
  private hold = 0;
  private sending = false;
  private seq = 0;
  private ptt = false;
  private muted = false;

  constructor(options: VoipClientOptions) {
    this.o = {
      frameMs: 20,
      bitrate: 24000,
      mode: 'voice',
      gateDb: -50,
      hangoverMs: 300,
      prerollFrames: 2,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      talkTimeoutMs: 250,
      ...options,
      jitter: { minMs: 40, maxMs: 400, startMs: 80, ...options.jitter },
    };
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.output = this.ctx.createGain();
    this.output.connect(this.ctx.destination);
    const url = workletUrl();
    this.ready = this.ctx.audioWorklet
      .addModule(url)
      .then(() => void (this.loaded = true))
      .finally(() => URL.revokeObjectURL(url));
  }

  /** Resume audio (call from a user gesture). Remote audio plays from here on. */
  async resume(): Promise<void> {
    await this.ready;
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Open the mic and start encoding. Also resumes audio. */
  async start(deviceId?: string): Promise<void> {
    await this.resume();
    this.stop();
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: this.o.echoCancellation,
        noiseSuppression: this.o.noiseSuppression,
        autoGainControl: this.o.autoGainControl,
      },
    });
    const frameSamples = (48000 * this.o.frameMs) / 1000;
    this.encoder = new AudioEncoder({
      output: (chunk) => this.onEncoded(chunk),
      error: (e) => console.warn('[voip] encoder', e),
    });
    this.encoder.configure({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: this.o.bitrate,
      opus: { frameDuration: this.o.frameMs * 1000, application: 'voip', signal: 'voice', complexity: 9 },
    } as AudioEncoderConfig);
    this.micSource = this.ctx.createMediaStreamSource(this.mic);
    this.micNode = new AudioWorkletNode(this.ctx, 'voip-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSamples },
    });
    this.micNode.port.onmessage = (e) => this.onFrame(e.data as Float32Array<ArrayBuffer>);
    this.micSource.connect(this.micNode);
  }

  /** Close the mic. Remote audio keeps playing. */
  stop(): void {
    this.micSource?.disconnect();
    this.micNode?.port.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.mic = this.micNode = this.micSource = this.encoder = undefined;
    this.gate.clear();
    this.preroll = [];
    this.setSending(false);
  }

  /** Stop everything and release the audio context. */
  async destroy(): Promise<void> {
    this.stop();
    for (const id of [...this.remotes.keys()]) this.removeSpeaker(id);
    await this.ctx.close();
  }

  setMode(mode: 'voice' | 'ptt'): void {
    this.o.mode = mode;
  }

  setPushToTalk(down: boolean): void {
    this.ptt = down;
  }

  /** Local mute: stop sending. Also call your `voip_set_muted` reducer so others see it. */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setGateDb(db: number): void {
    this.o.gateDb = db;
  }

  /** Master output volume, 0..2. */
  setOutputVolume(v: number): void {
    this.output.gain.value = v;
  }

  /** Per-speaker volume, 0..2. */
  setVolume(speaker: number, v: number): void {
    const r = this.remotes.get(speaker);
    if (r) r.gain.gain.value = r.volume = v;
  }

  /** Turn proximity audio on (with the room's range) or off (null). */
  setSpatial(options: SpatialOptions | null): void {
    this.spatial = options;
    for (const id of [...this.remotes.keys()]) this.removeSpeaker(id);
  }

  /**
   * Where you are and which way you face, in the same coordinates your module passes to
   * `voip::set_position`. `up` defaults to +y; for a top-down 2D map with y pointing down
   * the screen, use forward (0,-1,0) and up (0,0,-1).
   */
  setListener(pos: Vec3, forward: Vec3 = { x: 0, y: 0, z: -1 }, up: Vec3 = { x: 0, y: 1, z: 0 }): void {
    const l = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos.x, t);
      l.positionY.setValueAtTime(pos.y, t);
      l.positionZ.setValueAtTime(pos.z, t);
      l.forwardX.setValueAtTime(forward.x, t);
      l.forwardY.setValueAtTime(forward.y, t);
      l.forwardZ.setValueAtTime(forward.z, t);
      l.upX.setValueAtTime(up.x, t);
      l.upY.setValueAtTime(up.y, t);
      l.upZ.setValueAtTime(up.z, t);
    } else {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Who is talking right now. */
  talking(): number[] {
    return [...this.remotes].filter(([, r]) => r.talking).map(([id]) => id);
  }

  /** A speaker's recent level in dBFS (-100 when silent). */
  level(speaker: number): number {
    return this.remotes.get(speaker)?.level ?? -100;
  }

  /** Feed every `voip_packet` row here. */
  receive(p: VoipPacketRow): void {
    if (!this.loaded) return; // worklets still loading: drop the first few ms
    this.stats.receivedPackets++;
    this.stats.receivedBytes += p.data.length;
    const r = this.remotes.get(p.speaker) ?? this.addSpeaker(p.speaker);
    if (r.panner && p.pos) {
      const t = this.ctx.currentTime;
      r.panner.positionX.setValueAtTime(p.pos.x, t);
      r.panner.positionY.setValueAtTime(p.pos.y, t);
      r.panner.positionZ.setValueAtTime(p.pos.z, t);
    }
    const ts = (r.ts += this.o.frameMs * 1000);
    if (p.flags & VOIP_FLAG_END) r.ends.add(ts);
    if (r.decoder.state === 'configured') {
      r.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: p.data }));
    }
    this.setTalking(p.speaker, r, !(p.flags & VOIP_FLAG_END));
  }

  /** Forget a speaker (e.g. when they leave the room). */
  removeSpeaker(speaker: number): void {
    const r = this.remotes.get(speaker);
    if (!r) return;
    clearTimeout(r.timer);
    if (r.decoder.state !== 'closed') r.decoder.close();
    r.node.disconnect();
    r.node.port.close();
    r.gain.disconnect();
    r.panner?.disconnect();
    this.remotes.delete(speaker);
    if (r.talking) this.onTalking(speaker, false);
  }

  // -- sending ---------------------------------------------------------------

  private onFrame(pcm: Float32Array<ArrayBuffer>): void {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const db = 10 * Math.log10(sum / pcm.length + 1e-10);
    this.onMicLevel(db);

    let open: boolean;
    if (this.muted) open = false;
    else if (this.o.mode === 'ptt') open = this.ptt;
    else {
      if (db > this.o.gateDb) this.hold = this.o.hangoverMs;
      else this.hold -= this.o.frameMs;
      open = this.hold > 0;
    }
    const ts = (this.encodeTs += this.o.frameMs * 1000);
    this.gate.set(ts, open ? 'open' : this.sending ? 'end' : 'closed');
    if (open !== this.sending) this.setSending(open);
    if (!this.encoder || this.encoder.state !== 'configured') return;
    const data = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: ts, data: pcm });
    this.encoder.encode(data);
    data.close();
  }

  private onEncoded(chunk: EncodedAudioChunk): void {
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const state = this.gate.get(chunk.timestamp) ?? 'closed';
    this.gate.delete(chunk.timestamp);
    if (state === 'closed') {
      this.preroll.push(bytes);
      if (this.preroll.length > this.o.prerollFrames) this.preroll.shift();
      return;
    }
    for (const b of this.preroll) this.emit(b, 0);
    this.preroll = [];
    this.emit(bytes, state === 'end' ? VOIP_FLAG_END : 0);
  }

  private emit(bytes: Uint8Array, flags: number): void {
    const seq = this.seq;
    this.seq = (this.seq + 1) >>> 0;
    this.stats.sentPackets++;
    this.stats.sentBytes += bytes.length;
    try {
      const r = this.o.send(seq, flags, bytes);
      if (r instanceof Promise) r.catch(() => this.stats.rejected++);
    } catch {
      this.stats.rejected++;
    }
  }

  private setSending(on: boolean): void {
    if (this.sending === on) return;
    this.sending = on;
    this.onSending(on);
  }

  // -- receiving -------------------------------------------------------------

  private addSpeaker(speaker: number): Remote {
    const node = new AudioWorkletNode(this.ctx, 'voip-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: this.o.jitter,
    });
    node.port.onmessage = (e) => {
      if (e.data.underrun) this.stats.underruns++;
    };
    const gain = this.ctx.createGain();
    node.connect(gain);
    let panner: PannerNode | undefined;
    if (this.spatial) {
      const range = this.spatial.range;
      panner = new PannerNode(this.ctx, {
        panningModel: this.spatial.panningModel ?? 'HRTF',
        distanceModel: 'linear',
        refDistance: this.spatial.refDistance ?? range * 0.15,
        maxDistance: range,
        rolloffFactor: 1,
      });
      gain.connect(panner).connect(this.output);
    } else {
      gain.connect(this.output);
    }
    const r: Remote = {
      decoder: undefined as unknown as AudioDecoder,
      node,
      gain,
      panner,
      volume: 1,
      talking: false,
      ts: 0,
      ends: new Set(),
      level: -100,
    };
    r.decoder = new AudioDecoder({
      output: (audio) => {
        const pcm = new Float32Array(audio.numberOfFrames);
        audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
        const end = r.ends.delete(audio.timestamp);
        audio.close();
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        r.level = 10 * Math.log10(sum / pcm.length + 1e-10);
        node.port.postMessage({ pcm, end }, [pcm.buffer]);
      },
      error: (e) => {
        console.warn('[voip] decoder', e);
        this.removeSpeaker(speaker);
      },
    });
    r.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    this.remotes.set(speaker, r);
    return r;
  }

  private setTalking(speaker: number, r: Remote, on: boolean): void {
    clearTimeout(r.timer);
    if (on) r.timer = setTimeout(() => this.setTalking(speaker, r, false), this.o.talkTimeoutMs);
    if (r.talking !== on) {
      r.talking = on;
      if (!on) r.level = -100;
      this.onTalking(speaker, on);
    }
  }
}
