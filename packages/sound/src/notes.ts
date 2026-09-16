import type { Note, Scale } from './types.js';

const LETTERS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a note. "C4" is 60, "A4" is 69; accidentals are # and b. */
export function toMidi(note: Note): number {
  if (typeof note === 'number') return note;
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(note.trim());
  if (!m) throw new Error(`not a note: "${note}"`);
  const [, letter, accidental, octave] = m;
  const shift = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return (Number(octave) + 1) * 12 + LETTERS[letter!.toUpperCase()]! + shift;
}

/** Equal temperament, A4 = 440 Hz. */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const STEPS: Record<Exclude<Scale, 'none'>, number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};

/** The nearest note of `scale` rooted at `root`. "none" leaves the pitch continuous. */
export function snapToScale(midi: number, scale: Scale, root: number): number {
  if (scale === 'none') return midi;
  const steps = STEPS[scale];
  const rel = midi - root;
  const octave = Math.floor(rel / 12);
  let best = midi;
  let bestDist = Infinity;
  for (const o of [octave - 1, octave, octave + 1]) {
    for (const s of steps) {
      const candidate = root + o * 12 + s;
      const d = Math.abs(candidate - midi);
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
  }
  return best;
}
