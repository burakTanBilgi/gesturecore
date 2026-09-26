import type { Features, HandLabel, HandState, PinchFinger } from 'gesturecore';

/** What the chord reader needs to know about one hand. Same shape the sound brick uses. */
export type HandReading = { features: Features | null; state: HandState | null };

export type ReadHand = (hand: HandLabel) => HandReading;

/**
 * A hand shape that selects something: a pose the core reports by name, or a pinch
 * on a named finger. Both are things the core already detects — this brick adds no
 * geometry of its own.
 */
export type Shape = { pose: string } | { pinch: PinchFinger };

export type ChordQuality = 'major' | 'minor';

/** A semitone shift on the root: -1 flat, 0 natural, +1 sharp. */
export type Accidental = -1 | 0 | 1;

export type Chord = {
  /** The letter its shape selected, as written in the config. */
  letter: string;
  accidental: Accidental;
  quality: ChordQuality;
  /** "A", "Am", "A#", "Abm". */
  name: string;
  /** MIDI numbers, root first. */
  notes: number[];
};

/**
 * How the root gets sharpened or flattened. Tilt is continuous, so it needs two
 * angles rather than one: it takes `enterDeg` to pick an accidental up and coming
 * back inside `exitDeg` to put it down. Between the two, whatever is held stays
 * held — without that dead band a hand resting near the threshold flaps.
 */
export type AccidentalConfig = {
  source: 'tilt' | 'none';
  enterDeg: number;
  exitDeg: number;
  /** Swap which way sharpens. */
  invert: boolean;
};

export type ChordConfig = {
  /**
   * The hand that picks the letter. The other hand carries quality. Nothing else in
   * the brick assumes a side, so swapping this swaps both jobs at once.
   */
  noteHand: HandLabel;
  /** Letter → the shape that selects it. Any letters, in any order. */
  letters: Record<string, Shape>;
  /** The shape on the quality hand that makes a chord minor. Absent means major. */
  minor: Shape;
  accidental: AccidentalConfig;
  /** Octave of the root, scientific pitch notation: 4 puts A at MIDI 69. */
  octave: number;
  /**
   * Whether the note hand must be engaged before it can pick a letter. The core reports
   * a pose the moment it recognises the shape, well before the engage dwell finishes, so
   * without this a hand plays chords on its way up to being engaged at all.
   */
  requireEngaged: boolean;
  /**
   * Whether the shape that engages the hand also plays its chord. Off by default:
   * engaging is how you say "I mean this", not a chord you chose. The letter is muted
   * only until you make a different one, so it still plays when you actually pick it.
   */
  playOnEngage: boolean;
  trigger: Trigger;
  /**
   * `sustain` only: how long a chord survives the hands vanishing. Tracking drops for
   * a frame or two constantly, and without this every drop cuts the chord off.
   */
  releaseGraceMs: number;
};

/**
 * When a chord sounds. All three are worth trying with a real hand:
 *   engage   one shot the moment a chord is taken up — percussive, never sustained
 *   sustain  rings while the shape is held, stops when it is let go
 *   latch    rings until a different chord replaces it, ignoring the hands leaving
 */
export type Trigger = 'engage' | 'sustain' | 'latch';

export type ChordEvent =
  | { type: 'chord:start'; chord: Chord; t: number }
  | { type: 'chord:end'; chord: Chord; t: number };

/** Partial config, for changing one thing without restating the rest. */
export type ChordConfigPatch = Partial<ChordConfig>;
