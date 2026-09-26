import type { Features, HandLabel, HandState } from 'gesturecore';
import { describe, expect, it } from 'vitest';
import { readChord } from '../src/chord.js';
import { defaultChordConfig } from '../src/defaults.js';
import type { ReadHand } from '../src/types.js';

const deg = (d: number) => (d * Math.PI) / 180;

function features(over: Partial<Features> = {}): Features {
  return {
    pinch: 0.5,
    pinchRaw: 0.4,
    pinchRaws: { index: 0.4, middle: 0.6, ring: 0.7, pinky: 0.8 },
    openness: 0.5,
    curls: [0.2, 0.2, 0.2, 0.2, 0.2],
    tilt: 0,
    centroid: { x: 0.5, y: 0.5 },
    span: 0.2,
    ...over,
  } as Features;
}

function state(over: Partial<HandState> = {}): HandState {
  return { engaged: true, pinched: false, pinchFinger: null, pose: null, ...over } as HandState;
}

function reader(hands: Partial<Record<HandLabel, { f?: Partial<Features>; s?: Partial<HandState> }>>): ReadHand {
  return (hand) => {
    const h = hands[hand];
    return h ? { features: features(h.f), state: state(h.s) } : { features: null, state: null };
  };
}

/** The note hand holding A, tilted by `tiltDeg`. */
const tiltedA = (tiltDeg: number) => reader({ Right: { s: { pose: 'point' }, f: { tilt: deg(tiltDeg) } }, Left: {} });

describe('the triad', () => {
  it('sounds A major as A, C sharp, E', () => {
    const chord = readChord(defaultChordConfig(), tiltedA(0));

    expect(chord?.notes).toEqual([69, 73, 76]);
  });

  it('flattens the third for a minor chord', () => {
    const read = reader({
      Right: { s: { pose: 'point' } },
      Left: { s: { pinched: true, pinchFinger: 'middle' } },
    });

    expect(readChord(defaultChordConfig(), read)?.notes).toEqual([69, 72, 76]);
  });

  it('moves the whole chord by octave', () => {
    const config = { ...defaultChordConfig(), octave: 3 };

    expect(readChord(config, tiltedA(0))?.notes).toEqual([57, 61, 64]);
  });
});

describe('accidentals from tilt', () => {
  it('stays natural while the hand is upright', () => {
    const chord = readChord(defaultChordConfig(), tiltedA(4));

    expect(chord).toMatchObject({ accidental: 0, name: 'A' });
  });

  it('sharpens when the hand tilts past the threshold', () => {
    const chord = readChord(defaultChordConfig(), tiltedA(30));

    expect(chord).toMatchObject({ accidental: 1, name: 'A#', notes: [70, 74, 77] });
  });

  it('flattens when the hand tilts the other way', () => {
    const chord = readChord(defaultChordConfig(), tiltedA(-30));

    expect(chord).toMatchObject({ accidental: -1, name: 'Ab', notes: [68, 72, 75] });
  });

  it('holds a sharp through the dead band so it cannot flap', () => {
    const config = defaultChordConfig();
    // Between exit and enter: rising from natural it is not yet sharp …
    expect(readChord(config, tiltedA(16), 0)?.accidental).toBe(0);
    // … but falling from sharp it stays sharp.
    expect(readChord(config, tiltedA(16), 1)?.accidental).toBe(1);
  });

  it('releases the sharp once the hand comes back inside the exit angle', () => {
    expect(readChord(defaultChordConfig(), tiltedA(6), 1)?.accidental).toBe(0);
  });

  it('can be turned off entirely', () => {
    const config = { ...defaultChordConfig(), accidental: { source: 'none' as const, enterDeg: 20, exitDeg: 12, invert: false } };

    expect(readChord(config, tiltedA(40))?.accidental).toBe(0);
  });

  it('can be inverted so tilting the other way sharpens', () => {
    const config = { ...defaultChordConfig() };
    config.accidental = { ...config.accidental, invert: true };

    expect(readChord(config, tiltedA(30))?.accidental).toBe(-1);
  });
});
