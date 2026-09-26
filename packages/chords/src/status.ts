import { holdsShape, readAccidental, readChord } from './chord.js';
import type { Accidental, Chord, ChordConfig, ChordQuality, ReadHand, Shape } from './types.js';

export type LetterStatus = {
  letter: string;
  shape: Shape;
  /** Held right now. */
  held: boolean;
  /**
   * Its shape can never match, because the pose it names is not in the core's config.
   * The counting poses are not core defaults, so a fresh bench shows three of these
   * until they are recorded.
   */
  missing: boolean;
};

/** Everything a panel needs to draw the whole scheme at once. */
export type ChordStatus = {
  letters: LetterStatus[];
  quality: ChordQuality;
  accidental: Accidental;
  chord: Chord | null;
};

/**
 * A snapshot for a UI: every letter with whether it is held or unreachable, plus the
 * chord the hands are currently making. Pure, like everything else here — the bench
 * calls it once a frame and draws the result.
 */
export function chordStatus(
  config: ChordConfig,
  read: ReadHand,
  knownPoses: readonly string[],
  previous: Accidental = 0,
): ChordStatus {
  const note = read(config.noteHand);
  const other = config.noteHand === 'Right' ? 'Left' : 'Right';

  const letters = Object.entries(config.letters).map(([letter, shape]) => ({
    letter,
    shape,
    held: holdsShape(note, shape),
    missing: 'pose' in shape && !knownPoses.includes(shape.pose),
  }));

  return {
    letters,
    quality: holdsShape(read(other), config.minor) ? 'minor' : 'major',
    accidental: readAccidental(config, note, previous),
    chord: readChord(config, read, previous),
  };
}
