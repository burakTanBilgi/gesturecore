import type { Features, HandLabel, HandState } from 'gesturecore';
import { describe, expect, it } from 'vitest';
import { defaultChordConfig } from '../src/defaults.js';
import { chordStatus } from '../src/status.js';
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

/** What the core ships with, before anyone records the counting poses. */
const CORE_POSES = ['fist', 'openPalm', 'point'];
const ALL_POSES = [...CORE_POSES, 'peace', 'three', 'four'];

describe('chordStatus', () => {
  it('lists every letter in config order', () => {
    const status = chordStatus(defaultChordConfig(), reader({}), ALL_POSES);

    expect(status.letters.map((l) => l.letter)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  });

  it('marks the letter the note hand is holding', () => {
    const read = reader({ Right: { s: { pose: 'fist' } }, Left: {} });

    const held = chordStatus(defaultChordConfig(), read, ALL_POSES).letters.filter((l) => l.held);

    expect(held.map((l) => l.letter)).toEqual(['F']);
  });

  it('marks letters whose pose the core does not know, so the panel can grey them out', () => {
    const status = chordStatus(defaultChordConfig(), reader({}), CORE_POSES);

    expect(status.letters.filter((l) => l.missing).map((l) => l.letter)).toEqual(['B', 'C', 'D']);
  });

  it('never calls a pinch letter missing — a pinch needs no pose', () => {
    const status = chordStatus(defaultChordConfig(), reader({}), []);

    expect(status.letters.find((l) => l.letter === 'G')?.missing).toBe(false);
  });

  it('reports the quality and accidental the hands are asking for', () => {
    const read = reader({
      Right: { s: { pose: 'point' }, f: { tilt: deg(30) } },
      Left: { s: { pinched: true, pinchFinger: 'middle' } },
    });

    const status = chordStatus(defaultChordConfig(), read, ALL_POSES);

    expect(status).toMatchObject({ quality: 'minor', accidental: 1 });
    expect(status.chord?.name).toBe('A#m');
  });

  it('reports no chord when the note hand holds nothing', () => {
    const status = chordStatus(defaultChordConfig(), reader({}), ALL_POSES);

    expect(status.chord).toBeNull();
    expect(status.quality).toBe('major');
  });
});
