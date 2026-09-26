import type { ChordConfig } from './types.js';

/**
 * The scheme from the demonstration: the note hand counts the scale on its fingers,
 * and the other hand decides major or minor.
 *
 * One finger is A and each finger after it steps up the scale, which covers A..E.
 * That runs out at five, so the last two reuse shapes the core already knows: F is
 * the closed fist — nothing extended, the count wrapped round — and G is a pinch.
 *
 * `peace`, `three` and `four` are not core defaults; record them in the bench's pose
 * recorder, or point these entries at whatever you name them.
 */
export function defaultChordConfig(): ChordConfig {
  return {
    noteHand: 'Right',
    letters: {
      A: { pose: 'point' },
      B: { pose: 'peace' },
      C: { pose: 'three' },
      D: { pose: 'four' },
      E: { pose: 'openPalm' },
      F: { pose: 'fist' },
      G: { pinch: 'index' },
    },
    minor: { pinch: 'middle' },
    // Tilt is already measured per hand and nothing else uses it. The angles are wide
    // on purpose: a hand held naturally drifts several degrees without meaning to.
    accidental: { source: 'tilt', enterDeg: 20, exitDeg: 12, invert: false },
    octave: 4,
    trigger: 'sustain',
    releaseGraceMs: 120,
  };
}
