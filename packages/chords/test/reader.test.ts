import type { Features, HandLabel, HandState } from 'gesturecore';
import { describe, expect, it } from 'vitest';
import { ChordReader } from '../src/index.js';
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

/** The note hand holding the pose that selects `letter` in the default map. */
const holding = (pose: string) => reader({ Right: { s: { pose } }, Left: {} });
const nothing: ReadHand = () => ({ features: null, state: null });

const names = (events: { type: string; chord: { name: string } }[]) => events.map((e) => `${e.type} ${e.chord.name}`);

describe('trigger: engage', () => {
  it('fires once when the chord is first held and not again while it is held', () => {
    const chords = new ChordReader({ trigger: 'engage' });

    expect(names(chords.update(holding('point'), 0))).toEqual(['chord:start A']);
    expect(chords.update(holding('point'), 16)).toEqual([]);
    expect(chords.update(holding('point'), 32)).toEqual([]);
  });

  it('says nothing when the chord is released', () => {
    const chords = new ChordReader({ trigger: 'engage' });
    chords.update(holding('point'), 0);

    expect(chords.update(nothing, 16)).toEqual([]);
  });

  it('fires again for the next chord', () => {
    const chords = new ChordReader({ trigger: 'engage' });
    chords.update(holding('point'), 0);

    expect(names(chords.update(holding('fist'), 16))).toEqual(['chord:start F']);
  });
});

describe('trigger: sustain', () => {
  it('rings while held and ends on release', () => {
    const chords = new ChordReader({ trigger: 'sustain', releaseGraceMs: 0 });

    expect(names(chords.update(holding('point'), 0))).toEqual(['chord:start A']);
    expect(chords.update(holding('point'), 16)).toEqual([]);
    expect(names(chords.update(nothing, 32))).toEqual(['chord:end A']);
  });

  it('ends the old chord before starting the new one', () => {
    const chords = new ChordReader({ trigger: 'sustain', releaseGraceMs: 0 });
    chords.update(holding('point'), 0);

    expect(names(chords.update(holding('fist'), 16))).toEqual(['chord:end A', 'chord:start F']);
  });

  it('rides out a dropped frame shorter than the grace period', () => {
    const chords = new ChordReader({ trigger: 'sustain', releaseGraceMs: 120 });
    chords.update(holding('point'), 0);

    expect(chords.update(nothing, 60)).toEqual([]);
    expect(names(chords.update(holding('point'), 100))).toEqual([]);
    expect(chords.current?.name).toBe('A');
  });

  it('gives up once the hand has been gone longer than the grace period', () => {
    const chords = new ChordReader({ trigger: 'sustain', releaseGraceMs: 120 });
    chords.update(holding('point'), 0);
    chords.update(nothing, 60);

    expect(names(chords.update(nothing, 200))).toEqual(['chord:end A']);
    expect(chords.current).toBeNull();
  });
});

describe('trigger: latch', () => {
  it('keeps ringing after the hands have gone', () => {
    const chords = new ChordReader({ trigger: 'latch' });
    chords.update(holding('point'), 0);

    expect(chords.update(nothing, 5000)).toEqual([]);
    expect(chords.current?.name).toBe('A');
  });

  it('swaps only when a different chord is held', () => {
    const chords = new ChordReader({ trigger: 'latch' });
    chords.update(holding('point'), 0);
    chords.update(nothing, 100);

    expect(names(chords.update(holding('fist'), 200))).toEqual(['chord:end A', 'chord:start F']);
  });
});

describe('config', () => {
  it('can be changed while running, without rebuilding the reader', () => {
    const chords = new ChordReader({ trigger: 'engage' });
    chords.update(holding('point'), 0);

    chords.setConfig({ trigger: 'sustain', releaseGraceMs: 0 });
    chords.update(holding('point'), 16);

    expect(names(chords.update(nothing, 32))).toEqual(['chord:end A']);
  });

  it('hands back a copy, so callers cannot mutate it from under the reader', () => {
    const chords = new ChordReader();
    chords.getConfig().letters['A'] = { pose: 'nonsense' };

    expect(chords.getConfig().letters['A']).toEqual({ pose: 'point' });
  });
});

describe('the shape that engages the hand', () => {
  /** Not engaged, then engaged: the transition the reader has to see to mute anything. */
  const engaging = (pose: string, engaged: boolean) => reader({ Right: { s: { pose, engaged } }, Left: {} });

  it('does not play, because engaging is not a decision to sound a chord', () => {
    const chords = new ChordReader();
    expect(chords.update(engaging('openPalm', false), 0)).toEqual([]);
    expect(chords.update(engaging('openPalm', true), 16)).toEqual([]);
    expect(chords.update(engaging('openPalm', true), 32)).toEqual([]);
    expect(chords.current).toBe(null);
  });

  it('stops muting as soon as a different letter is made, and plays that one', () => {
    const chords = new ChordReader();
    chords.update(engaging('openPalm', false), 0);
    chords.update(engaging('openPalm', true), 16);
    expect(names(chords.update(holding('fist'), 32))).toEqual(['chord:start F']);
    // and the engaging letter plays normally once it is chosen rather than inherited
    expect(names(chords.update(holding('openPalm'), 48))).toEqual(['chord:end F', 'chord:start E']);
  });

  it('playOnEngage keeps the old behaviour for anyone who wants it', () => {
    const chords = new ChordReader({ playOnEngage: true });
    chords.update(engaging('openPalm', false), 0);
    expect(names(chords.update(engaging('openPalm', true), 16))).toEqual(['chord:start E']);
  });

  it('mutes again on a later engage, not only the first', () => {
    const chords = new ChordReader();
    chords.update(engaging('openPalm', false), 0);
    chords.update(engaging('openPalm', true), 16);
    chords.update(nothing, 32);
    chords.update(engaging('openPalm', false), 48);
    expect(chords.update(engaging('openPalm', true), 64)).toEqual([]);
  });

  it('a hand already engaged when the reader starts is not treated as engaging', () => {
    const chords = new ChordReader();
    expect(names(chords.update(holding('openPalm'), 0))).toEqual(['chord:start E']);
  });
});
