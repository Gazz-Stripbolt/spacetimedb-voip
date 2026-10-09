// AudioWorklet processors, kept as source strings so the client is one import with no
// extra files to host. Both resample with linear interpolation between the context's rate
// and Opus's 48 kHz, so any AudioContext rate works (Firefox can't mix rates in one graph).

/** Mic → fixed-size 48 kHz frames, posted to the main thread. */
const capture = /* js */ `
class VoipCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.n = options.processorOptions.frameSamples;
    this.step = sampleRate / 48000; // input samples per output sample
    this.t = 0;
    this.prev = 0;
    this.frame = new Float32Array(this.n);
    this.i = 0;
  }
  push(v) {
    this.frame[this.i++] = v;
    if (this.i === this.n) {
      const f = this.frame;
      this.port.postMessage(f, [f.buffer]);
      this.frame = new Float32Array(this.n);
      this.i = 0;
    }
  }
  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x || !x.length) return true;
    const L = x.length;
    if (this.step === 1) {
      for (let k = 0; k < L; k++) this.push(x[k]);
      return true;
    }
    while (this.t < L - 1) {
      const i = Math.floor(this.t);
      const f = this.t - i;
      const a = i < 0 ? this.prev : x[i];
      this.push(a + (x[i + 1] - a) * f);
      this.t += this.step;
    }
    this.t -= L;
    this.prev = x[L - 1];
    return true;
  }
}
registerProcessor('voip-capture', VoipCapture);
`;

/**
 * One per remote speaker: an adaptive jitter buffer. Buffers \`target\` ms before playing,
 * grows the target on underrun, shrinks it slowly while playback is smooth, and skips ahead
 * if it falls too far behind. Stores 48 kHz audio and resamples on the way out.
 */
const playback = /* js */ `
class VoipPlayback extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.cap = 48000 * 4;
    this.ring = new Float32Array(this.cap);
    this.w = 0;            // samples written (48 kHz)
    this.r = 0;            // read position (48 kHz, fractional)
    this.step = 48000 / sampleRate;
    this.min = o.minMs * 48;
    this.max = o.maxMs * 48;
    this.target = o.startMs * 48;
    this.playing = false;
    this.ended = true;     // talk spurt finished: draining is not an underrun
    this.smooth = 0;       // output samples since the last underrun
    this.underruns = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.pcm) this.write(m.pcm);
      if (m.end) this.ended = true;
    };
  }
  write(pcm) {
    if (this.ended) {
      // New talk spurt. If the last one has drained, buffer afresh before playing.
      this.ended = false;
      if (this.r + 1 >= this.w) {
        this.r = this.w;
        this.playing = false;
      }
    }
    if (this.w + pcm.length - this.r > this.cap) this.r = this.w + pcm.length - this.cap;
    for (let k = 0; k < pcm.length; k++) this.ring[(this.w + k) % this.cap] = pcm[k];
    this.w += pcm.length;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    const buffered = this.w - this.r;
    if (!this.playing) {
      if (buffered >= this.target || (this.ended && buffered > 0)) this.playing = true;
      else return true;
    }
    for (let k = 0; k < out.length; k++) {
      if (this.r + 1 >= this.w) {
        if (!this.ended) {
          this.underruns++;
          this.target = Math.min(this.max, this.target + 20 * 48);
          this.smooth = 0;
          this.port.postMessage({ underrun: this.underruns, targetMs: this.target / 48 });
        }
        this.playing = false;
        return true;
      }
      const i = Math.floor(this.r);
      const f = this.r - i;
      const a = this.ring[i % this.cap];
      const b = this.ring[(i + 1) % this.cap];
      out[k] = a + (b - a) * f;
      this.r += this.step;
    }
    this.smooth += out.length;
    if (this.smooth > sampleRate * 8 && this.target > this.min) {
      this.target = Math.max(this.min, this.target - 5 * 48);
      this.smooth = 0;
    }
    // Way behind (e.g. a burst after a stall): skip to the target so latency stays bounded.
    if (!this.ended && this.w - this.r > this.target + Math.max(this.target, 120 * 48)) this.r = this.w - this.target;
    return true;
  }
}
registerProcessor('voip-playback', VoipPlayback);
`;

export function workletUrl(): string {
  return URL.createObjectURL(new Blob([capture, playback], { type: 'text/javascript' }));
}
