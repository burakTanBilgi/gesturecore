import type { GestureEvent } from 'gesturecore';
import { defaultSoundConfig } from './defaults.js';
import { SoundEngine } from './engine.js';
import { planSound } from './plan.js';
import type { ReadHand, SoundConfig, SoundConfigPatch } from './types.js';

/**
 * Sound for gesturecore, as an optional brick: feed it what the core produced each
 * frame and it plays. The core never knows it exists.
 *
 * ```ts
 * const sound = new GestureSound();
 * button.onclick = () => sound.start();          // browsers need a user action first
 * const events = core.update(hands, t);
 * sound.update(events, readerFor(core));
 * ```
 */
export class GestureSound {
  private config: SoundConfig;

  constructor(
    config: SoundConfigPatch = {},
    readonly engine: SoundEngine = new SoundEngine(),
  ) {
    this.config = { ...defaultSoundConfig(), ...config };
    engine.setVolume(this.config.volume);
  }

  start(): Promise<void> {
    return this.engine.start();
  }

  stop(): Promise<void> {
    return this.engine.stop();
  }

  get running(): boolean {
    return this.engine.running;
  }

  /** Plan this frame and play it. Cheap when nothing is happening. */
  update(events: readonly GestureEvent[], read: ReadHand): void {
    if (!this.engine.running) return;
    this.engine.apply(planSound(this.config, events, read));
  }

  getConfig(): SoundConfig {
    return JSON.parse(JSON.stringify(this.config)) as SoundConfig;
  }

  setConfig(patch: SoundConfigPatch): void {
    this.config = { ...this.config, ...patch };
    if (patch.volume !== undefined) this.engine.setVolume(patch.volume);
  }
}

export { SoundEngine } from './engine.js';
export { planCues, planSound, planVoices, readSource, readerFor } from './plan.js';
export { midiToHz, snapToScale, toMidi } from './notes.js';
export { DEFAULT_CUES, THEREMIN, defaultSoundConfig } from './defaults.js';
export type {
  ControlDescription,
  ControlSource,
  ControlTarget,
  CueDescription,
  HandReading,
  Note,
  ReadHand,
  Scale,
  SoundAction,
  SoundConfig,
  SoundConfigPatch,
  SoundName,
  Waveform,
} from './types.js';
