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
    // Raising the palm names the pose long before any of that, and none of it sounds.
    expect(feed(open, 300)).toEqual([]);
    expect(core.getHandState('Right')?.pose).toBe('openPalm');
    expect(core.getHandState('Right')?.engaged).toBe(false);

    expect(feed(open, 600)).toEqual([]);
    expect(core.getHandState('Right')?.engaged).toBe(true);

    // openPalm is E, but this E is a by-product of engaging rather than one you chose.
    expect(chords.current).toBe(null);

    // Close the hand: F is the fist.
    expect(feed(fist, 600)).toContain('chord:start F');
    expect(chords.current?.name).toBe('F');

    // And now openPalm means E, because opening the hand is a choice this time.
    expect(feed(open, 600)).toContain('chord:start E');
    expect(chords.current?.name).toBe('E');
  });

  it('plays the engaging chord when playOnEngage is on', () => {
    const core = new GestureCore({ aspect: 1 });
    const chords = new ChordReader({ trigger: 'sustain', playOnEngage: true });
    const read = readerFor(core);
    const open = fixture('open');

    for (let t = 0; t <= 900; t += 16) {
      core.update([hand(open)], t);
      chords.update(read, t);
    }
    expect(core.getHandState('Right')?.engaged).toBe(true);
    expect(chords.current?.name).toBe('E');
  });
});
