import { readFileSync } from 'node:fs';
import { GestureCore } from 'gesturecore';
import type { Hand, HandLabel, Landmark } from 'gesturecore';
import { describe, expect, it } from 'vitest';
import { ChordReader, readerFor } from '../src/index.js';

/** The core's own fixtures, so this runs against real landmarks rather than invented ones. */
function fixture(name: 'open' | 'fist' | 'point'): Landmark[] {
  const url = new URL(`../../core/test/fixtures/${name}.json`, import.meta.url);
  const file = JSON.parse(readFileSync(url, 'utf8')) as Landmark[] | { views: { view: string; landmarks: Landmark[] }[] };
  if (Array.isArray(file)) return file;
  return (file.views.find((v) => v.view === 'front') ?? file.views[0]!).landmarks;
}

const hand = (landmarks: Landmark[], handedness: HandLabel = 'Right'): Hand => ({ landmarks, handedness, score: 1 });

describe('readerFor', () => {
  it('reads the core live, so one reader serves every frame', () => {
    const core = new GestureCore({ aspect: 1 });
    const read = readerFor(core);
    expect(read('Right').features).toBe(null);
    core.update([hand(fixture('open'))], 0);
    expect(read('Right').features).not.toBe(null);
    expect(read('Right').state).not.toBe(null);
    expect(read('Left').features).toBe(null);
  });
});

describe('against a real GestureCore', () => {
  it('turns held landmarks into a chord', () => {
    const core = new GestureCore({ aspect: 1 });
    const chords = new ChordReader({ trigger: 'sustain' });
    const read = readerFor(core);
    const open = fixture('open');
    const fist = fixture('fist');

    let t = 0;
    const feed = (landmarks: Landmark[], ms: number) => {
      const until = t + ms;
      const seen: string[] = [];
      for (; t <= until; t += 16) {
        core.update([hand(landmarks)], t);
        for (const e of chords.update(read, t)) seen.push(`${e.type} ${e.chord.name}`);
      }
      return seen;
    };

    // Engage wants openPalm held for 500 ms; a pose then needs its own 300 ms dwell.
    feed(open, 900);
    expect(core.getHandState('Right')?.engaged).toBe(true);

    // openPalm is E in the default map, so engaging already sounds a chord.
    expect(chords.current?.name).toBe('E');

    // Close the hand: F is the fist.
    const events = feed(fist, 600);

    expect(events).toContain('chord:start F');
    expect(chords.current?.name).toBe('F');
  });
});
