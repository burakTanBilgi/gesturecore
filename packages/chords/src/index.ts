import { readChord } from './chord.js';
import { defaultChordConfig } from './defaults.js';
import type { Accidental, Chord, ChordConfig, ChordConfigPatch, ChordEvent, ReadHand } from './types.js';

/**
 * Chords for gesturecore, as an optional brick: one hand picks the note, the other
 * decides major or minor. The core never knows it exists, and nothing here touches
 * audio — it turns hands into chord names and leaves playing them to someone else.
 *
 * ```ts
 * const chords = new ChordReader();
 * core.update(hands, t);
 * for (const e of chords.update(readerFor(core), t)) {
 *   if (e.type === 'chord:start') console.log(e.chord.name, e.chord.notes);
 * }
 * ```
 */
export class ChordReader {
  private config: ChordConfig;
  private held: Chord | null = null;
  private accidental: Accidental = 0;
  /** When the hands stopped offering a chord, while one is still held. */
  private lostAt: number | null = null;

  constructor(config: ChordConfigPatch = {}) {
    this.config = { ...defaultChordConfig(), ...config };
  }

  /** The chord sounding right now, or null. */
  get current(): Chord | null {
    return this.held;
  }

  /** Read this frame. Returns what changed — usually nothing. */
  update(read: ReadHand, t: number): ChordEvent[] {
    const seen = readChord(this.config, read, this.accidental);
    if (seen) this.accidental = seen.accidental;

    if (!seen) return this.nothingHeld(t);

    this.lostAt = null;
    if (this.held && this.held.name === seen.name) return [];

    const events: ChordEvent[] = [];
    if (this.held && this.config.trigger !== 'engage') {
      events.push({ type: 'chord:end', chord: this.held, t });
    }
    this.held = seen;
    events.push({ type: 'chord:start', chord: seen, t });
    return events;
  }

  /** Forget whatever is held, without emitting anything. */
  reset(): void {
    this.held = null;
    this.accidental = 0;
    this.lostAt = null;
  }

  getConfig(): ChordConfig {
    return JSON.parse(JSON.stringify(this.config)) as ChordConfig;
  }

  setConfig(patch: ChordConfigPatch): void {
    this.config = { ...this.config, ...patch };
  }

  /** No chord on offer this frame: decide whether the held one survives it. */
  private nothingHeld(t: number): ChordEvent[] {
    if (!this.held) return [];
    // `engage` never ended anything to begin with; `latch` holds until replaced.
    if (this.config.trigger !== 'sustain') {
      if (this.config.trigger === 'engage') this.held = null;
      return [];
    }
    if (this.lostAt === null) this.lostAt = t;
    if (t - this.lostAt < this.config.releaseGraceMs) return [];

    const ended = this.held;
    this.held = null;
    this.lostAt = null;
    return [{ type: 'chord:end', chord: ended, t }];
  }
}

export { holdsShape, readAccidental, readChord } from './chord.js';
export { defaultChordConfig } from './defaults.js';
export { readerFor } from './read.js';
export { chordStatus } from './status.js';
export type { ChordStatus, LetterStatus } from './status.js';
export type {
  Accidental,
  AccidentalConfig,
  Chord,
  ChordConfig,
  ChordConfigPatch,
  ChordEvent,
  ChordQuality,
  HandReading,
  ReadHand,
  Shape,
  Trigger,
} from './types.js';
