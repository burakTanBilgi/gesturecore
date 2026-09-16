/**
 * Plays planned actions through the Web Audio API. The only file in this package that
 * touches the browser; everything it is told to do was decided in plan.ts.
 */
import type { SoundAction, SoundName, Waveform } from './types.js';

type Voice = { osc: OscillatorNode; filter: BiquadFilterNode; amp: GainNode; pan: StereoPannerNode; on: boolean };

/** How quickly a sustained voice follows the hand, in seconds. Short enough to feel live, long enough not to click. */
const GLIDE = 0.04;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly voices = new Map<string, Voice>();
  private volume = 0.7;

  constructor(private readonly makeContext: () => AudioContext = () => new AudioContext()) {}

  /** Browsers only allow sound after a user action: call this from a click. */
  async start(): Promise<void> {
    if (!this.ctx) {
      this.ctx = this.makeContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  /** Silence everything and release the audio device. */
  async stop(): Promise<void> {
    for (const v of this.voices.values()) v.osc.stop();
    this.voices.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    await ctx?.close();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  apply(actions: readonly SoundAction[]): void {
    if (!this.running) return;
    for (const a of actions) {
      if (a.kind === 'play') this.play(a.sound, a.frequency, a.gain, a.pan);
      else this.voice(a);
    }
  }

  // ── one-shots ─────────────────────────────────────────────────────────────

  private out(pan: number, at: number): { amp: GainNode; end: (t: number) => void } {
    const ctx = this.ctx!;
    const amp = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    amp.gain.setValueAtTime(0, at);
    amp.connect(panner).connect(this.master!);
    return {
      amp,
      end: (t) => setTimeout(() => {
        amp.disconnect();
        panner.disconnect();
      }, Math.max(0, (t - ctx.currentTime) * 1000) + 50),
    };
  }

  private envelope(g: AudioParam, at: number, peak: number, attack: number, decay: number): number {
    g.setValueAtTime(0.0001, at);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), at + attack);
    g.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    return at + attack + decay;
  }

  private tone(type: OscillatorType, freq: number, at: number, until: number, into: AudioNode): OscillatorNode {
    const osc = this.ctx!.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    osc.connect(into);
    osc.start(at);
    osc.stop(until + 0.02);
    return osc;
  }

  private play(sound: SoundName, f: number, gain: number, pan: number): void {
    const ctx = this.ctx!;
    const at = ctx.currentTime + 0.005;
    const { amp, end } = this.out(pan, at);
    let until = at;
    switch (sound) {
      case 'click':
        until = this.envelope(amp.gain, at, gain, 0.002, 0.03);
        this.tone('square', f, at, until, amp);
        break;
      case 'blip':
        until = this.envelope(amp.gain, at, gain, 0.005, 0.14);
        this.tone('sine', f, at, until, amp);
        break;
      case 'chime': {
        until = this.envelope(amp.gain, at, gain, 0.004, 0.9);
        this.tone('sine', f, at, until, amp);
        const overtone = ctx.createGain();
        overtone.gain.value = 0.35;
        overtone.connect(amp);
        this.tone('sine', f * 2.01, at, until, overtone);
        break;
      }
      case 'pluck': {
        until = this.envelope(amp.gain, at, gain, 0.003, 0.28);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(f * 8, at);
        lp.frequency.exponentialRampToValueAtTime(f * 1.2, until);
        lp.connect(amp);
        this.tone('triangle', f, at, until, lp);
        break;
      }
      case 'swoosh': {
        until = this.envelope(amp.gain, at, gain, 0.04, 0.26);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.2;
        bp.frequency.setValueAtTime(300, at);
        bp.frequency.exponentialRampToValueAtTime(3200, until);
        bp.connect(amp);
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer();
        src.connect(bp);
        src.start(at);
        src.stop(until + 0.02);
        break;
      }
      case 'thud': {
        until = this.envelope(amp.gain, at, gain, 0.003, 0.18);
        const osc = this.tone('sine', f, at, until, amp);
        osc.frequency.exponentialRampToValueAtTime(f / 2, until);
        break;
      }
      case 'rise':
      case 'fall': {
        until = this.envelope(amp.gain, at, gain, 0.02, 0.22);
        const [from, to] = sound === 'rise' ? [f, f * 2] : [f * 2, f];
        const osc = this.tone('sine', from, at, until, amp);
        osc.frequency.exponentialRampToValueAtTime(to, until);
        break;
      }
    }
    end(until);
  }

  private noiseBuffer(): AudioBuffer {
    if (this.noise) return this.noise;
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return (this.noise = buf);
  }

  // ── sustained voices ──────────────────────────────────────────────────────

  private voice(a: Extract<SoundAction, { kind: 'voice' }>): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    let v = this.voices.get(a.voice);
    if (!v && !a.on) return;
    if (!v) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const amp = ctx.createGain();
      const pan = ctx.createStereoPanner();
      filter.type = 'lowpass';
      amp.gain.value = 0;
      osc.connect(filter).connect(amp).connect(pan).connect(this.master!);
      osc.start();
      v = { osc, filter, amp, pan, on: false };
      this.voices.set(a.voice, v);
    }
    if (v.osc.type !== (a.waveform satisfies Waveform)) v.osc.type = a.waveform;
    v.osc.frequency.setTargetAtTime(a.frequency, now, GLIDE);
    v.filter.frequency.setTargetAtTime(a.brightness, now, GLIDE);
    v.pan.pan.setTargetAtTime(a.pan, now, GLIDE);
    v.amp.gain.setTargetAtTime(a.on ? a.gain : 0, now, a.on ? GLIDE : 0.08);
    v.on = a.on;
  }
}
