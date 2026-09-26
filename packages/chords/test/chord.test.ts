import type { Features, HandLabel, HandState } from 'gesturecore';
import { describe, expect, it } from 'vitest';
import { readChord } from '../src/chord.js';
import { defaultChordConfig } from '../src/defaults.js';
import type { ReadHand } from '../src/types.js';

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

describe('readChord', () => {
  it('names the chord for a pose held on the note hand', () => {
    const read = reader({ Right: { s: { pose: 'point' } }, Left: { s: { pose: 'openPalm' } } });

    expect(readChord(defaultChordConfig(), read)?.name).toBe('A');
  });

  it('selects a letter by pinch as well as by pose', () => {
    const read = reader({ Right: { s: { pinched: true, pinchFinger: 'index' } }, Left: {} });

    expect(readChord(defaultChordConfig(), read)?.letter).toBe('G');
  });

  it('turns the chord minor while the quality hand pinches its middle finger', () => {
    const read = reader({
      Right: { s: { pose: 'point' } },
      Left: { s: { pinched: true, pinchFinger: 'middle' } },
    });

    expect(readChord(defaultChordConfig(), read)).toMatchObject({ quality: 'minor', name: 'Am' });
  });

  it('stays major when the quality hand pinches a different finger', () => {
    const read = reader({
      Right: { s: { pose: 'point' } },
      Left: { s: { pinched: true, pinchFinger: 'ring' } },
    });

    expect(readChord(defaultChordConfig(), read)?.quality).toBe('major');
  });

  it('holds no chord when the note hand holds no known shape', () => {
    const read = reader({ Right: { s: { pose: 'thumbsUp' } }, Left: {} });

    expect(readChord(defaultChordConfig(), read)).toBeNull();
  });

  it('swaps both jobs when the note hand is set to the left', () => {
    const config = { ...defaultChordConfig(), noteHand: 'Left' as const };
    const read = reader({
      Left: { s: { pose: 'point' } },
      Right: { s: { pinched: true, pinchFinger: 'middle' } },
    });

    expect(readChord(config, read)?.name).toBe('Am');
  });

  it('takes the whole letter map from config, not just the default one', () => {
    const config = {
      ...defaultChordConfig(),
      letters: { C: { pose: 'fist' }, D: { pinch: 'ring' as const } },
      minor: { pose: 'point' },
    };
    const read = reader({ Right: { s: { pose: 'fist' } }, Left: { s: { pose: 'point' } } });

    expect(readChord(config, read)?.name).toBe('Cm');
  });
});
