import type { Accidental, Chord, ChordConfig, HandReading, ReadHand, Shape } from './types.js';

/** Semitones above C for each natural. */
const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Semitones above the root. A minor chord is a major chord with its third lowered. */
const TRIAD = { major: [0, 4, 7], minor: [0, 3, 7] };

/** Whether a hand is holding this shape right now. */
export function holdsShape(reading: HandReading, shape: Shape): boolean {
  const state = reading.state;
  if (!state) return false;
  if ('pose' in shape) return state.pose === shape.pose;
  return state.pinched && state.pinchFinger === shape.pinch;
}

/** The letter the note hand is selecting, or null. */
function readLetter(config: ChordConfig, note: HandReading): string | null {
  for (const [letter, shape] of Object.entries(config.letters)) {
    if (holdsShape(note, shape)) return letter;
  }
  return null;
}

/**
 * The accidental the note hand's tilt is asking for, given the one it already holds.
 * Pure: the caller keeps the previous value, so the dead band behaves the same whether
 * it is driven live or replayed from a recording.
 */
export function readAccidental(config: ChordConfig, note: HandReading, previous: Accidental): Accidental {
  const { source, enterDeg, exitDeg, invert } = config.accidental;
  if (source === 'none' || !note.features) return 0;

  const degrees = ((note.features.tilt * 180) / Math.PI) * (invert ? -1 : 1);
  const magnitude = Math.abs(degrees);
  const sign: Accidental = degrees > 0 ? 1 : -1;

  if (magnitude >= enterDeg) return sign;
  // Inside the dead band: keep what is held, and only on the side it is held.
  if (previous !== 0 && magnitude > exitDeg && sign === previous) return previous;
  return 0;
}

/** The name a chord is written by: "A", "Am", "A#", "Abm". */
function nameOf(letter: string, accidental: Accidental, quality: 'major' | 'minor'): string {
  const mark = accidental === 1 ? '#' : accidental === -1 ? 'b' : '';
  return letter + mark + (quality === 'minor' ? 'm' : '');
}

/**
 * The chord the hands are holding right now, or null if they are not holding one.
 * `previous` is the accidental held last frame — pass it to get the dead band.
 */
export function readChord(config: ChordConfig, read: ReadHand, previous: Accidental = 0): Chord | null {
  const note = read(config.noteHand);
  // Engagement is the whole system's "I mean this". The core names a pose as soon as it
  // sees the shape, so without this the hand plays on its way up to being engaged.
  if (config.requireEngaged && !note.state?.engaged) return null;

  const letter = readLetter(config, note);
  if (letter === null) return null;

  const other = config.noteHand === 'Right' ? 'Left' : 'Right';
  const quality = holdsShape(read(other), config.minor) ? 'minor' : 'major';
  const accidental = readAccidental(config, note, previous);

  const pitchClass = PITCH_CLASS[letter.toUpperCase()];
  const root = pitchClass === undefined ? null : (config.octave + 1) * 12 + pitchClass + accidental;
  const notes = root === null ? [] : TRIAD[quality].map((step) => root + step);

  return { letter, accidental, quality, name: nameOf(letter, accidental, quality), notes };
}
