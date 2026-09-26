import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Features, GestureEvent, HandLabel, HandState } from 'gesturecore';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CUES, THEREMIN, defaultSoundConfig } from '../src/defaults.js';
import type { SoundEngine } from '../src/engine.js';
import { GestureSound } from '../src/index.js';
import { midiToHz, snapToScale, toMidi } from '../src/notes.js';
import { planCues, planNotes, planSound, planVoices, readSource, readerFor } from '../src/plan.js';
import type { CueDescription, ReadHand, SoundAction } from '../src/types.js';

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

const ev = (e: Record<string, unknown>) => ({ hand: 'Right', t: 0, ...e }) as GestureEvent;
const plays = (a: SoundAction[]) => a.filter((x): x is Extract<SoundAction, { kind: 'play' }> => x.kind === 'play');

describe('notes', () => {
  it('reads note names', () => {
    expect(toMidi('C4')).toBe(60);
    expect(toMidi('A4')).toBe(69);
    expect(toMidi('C#5')).toBe(73);
    expect(toMidi('Bb3')).toBe(58);
    expect(toMidi('c-1')).toBe(0);
    expect(toMidi(64)).toBe(64);
  });

  it('refuses nonsense', () => {
    expect(() => toMidi('H2')).toThrow(/not a note/);
  });

  it('tunes A4 to 440 Hz and doubles per octave', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 9);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
  });

  it('snaps to the nearest note of a scale', () => {
    // C pentatonic: C D E G A
    expect(snapToScale(61, 'pentatonic', 60)).toBeOneOf([60, 62]);
    expect(snapToScale(65.4, 'pentatonic', 60)).toBe(64);
    expect(snapToScale(69.4, 'pentatonic', 60)).toBe(69);
    expect(snapToScale(70.8, 'pentatonic', 60)).toBe(72);
    expect(snapToScale(71.9, 'pentatonic', 60)).toBe(72);
    expect(snapToScale(66, 'major', 60)).toBeOneOf([65, 67]);
    expect(snapToScale(66.3, 'none', 60)).toBe(66.3);
  });

  it('snaps below the root too', () => {
    expect(snapToScale(57.4, 'pentatonic', 60)).toBe(57); // A3
    expect(snapToScale(55.2, 'pentatonic', 60)).toBe(55); // G3
  });
});

describe('cues', () => {
  const read = reader({ Right: { f: { centroid: { x: 0.9, y: 0.5 } } } });

  it('fires on a matching event and stays silent otherwise', () => {
    const cues: CueDescription[] = [{ on: 'engage', sound: 'rise' }];
    expect(plays(planCues(cues, [ev({ type: 'engage' })], read))).toHaveLength(1);
    expect(plays(planCues(cues, [ev({ type: 'lost' })], read))).toHaveLength(0);
  });

  it('narrows by finger, name and hand', () => {
    const cues: CueDescription[] = [
      { on: 'pinch:start', finger: 'middle', sound: 'blip' },
      { on: 'motion', name: 'wave', sound: 'chime' },
      { on: 'engage', hand: 'Left', sound: 'rise' },
    ];
    expect(plays(planCues(cues, [ev({ type: 'pinch:start', finger: 'index' })], read))).toHaveLength(0);
    expect(plays(planCues(cues, [ev({ type: 'pinch:start', finger: 'middle' })], read))).toHaveLength(1);
    expect(plays(planCues(cues, [ev({ type: 'motion', name: 'swipeLeft' })], read))).toHaveLength(0);
    expect(plays(planCues(cues, [ev({ type: 'motion', name: 'wave' })], read))).toHaveLength(1);
    expect(plays(planCues(cues, [ev({ type: 'engage' })], read))).toHaveLength(0);
    expect(plays(planCues(cues, [ev({ type: 'engage', hand: 'Left' })], read))).toHaveLength(1);
  });

  it('plays the named note, or the sound’s own default', () => {
    const [named] = plays(planCues([{ on: 'engage', sound: 'blip', note: 'A4' }], [ev({ type: 'engage' })], read));
    expect(named!.frequency).toBeCloseTo(440, 6);
    const [plain] = plays(planCues([{ on: 'engage', sound: 'blip' }], [ev({ type: 'engage' })], read));
    expect(plain!.frequency).toBeGreaterThan(0);
  });

  it('pans with the hand when asked', () => {
    const [p] = plays(planCues([{ on: 'engage', sound: 'blip', pan: 'hand' }], [ev({ type: 'engage' })], read));
    expect(p!.pan).toBeCloseTo(0.8, 6);
    const [fixed] = plays(planCues([{ on: 'engage', sound: 'blip', pan: -3 }], [ev({ type: 'engage' })], read));
    expect(fixed!.pan).toBe(-1);
  });

  it('keeps event order when several fire in one frame', () => {
    const out = plays(planCues(DEFAULT_CUES, [ev({ type: 'engage' }), ev({ type: 'pinch:start', finger: 'index' })], read));
    expect(out.map((p) => p.sound)).toEqual(['rise', 'blip']);
  });
});

describe('voices', () => {
  it('sound only while their condition holds', () => {
    const pinched = planVoices(THEREMIN, reader({ Right: { s: { pinched: true } } }));
    const loose = planVoices(THEREMIN, reader({ Right: { s: { pinched: false } } }));
    const gone = planVoices(THEREMIN, reader({}));
    expect(pinched).toHaveLength(1);
    expect(pinched[0]).toMatchObject({ kind: 'voice', voice: 'theremin', on: true });
    expect(loose[0]).toMatchObject({ on: false });
    expect(gone[0]).toMatchObject({ on: false });
  });

  it('merges several controls into one voice', () => {
    const [v] = planVoices(THEREMIN, reader({ Right: { s: { pinched: true }, f: { openness: 1, centroid: { x: 1, y: 0.5 } } } }));
    if (v?.kind !== 'voice') throw new Error('expected a voice');
    expect(v.gain).toBeCloseTo(0.6, 6);
    expect(v.brightness).toBeCloseTo(6000, 6);
  });

  it('raising the hand raises the pitch, on the scale', () => {
    const at = (y: number) => {
      const [v] = planVoices(THEREMIN, reader({ Right: { s: { pinched: true }, f: { centroid: { x: 0.5, y } } } }));
      return v?.kind === 'voice' ? v.frequency : NaN;
    };
    expect(at(0.1)).toBeGreaterThan(at(0.9));
    const midi = 69 + 12 * Math.log2(at(0.37) / 440);
    expect([0, 2, 4, 7, 9]).toContain(((Math.round(midi) % 12) + 12) % 12);
  });

  it('maps each source into 0..1', () => {
    const f = features({ tilt: Math.PI, span: 0.9, pinch: -1, centroid: { x: 2, y: -1 } });
    for (const s of ['x', 'y', 'pinch', 'openness', 'tilt', 'span'] as const) {
      const v = readSource(f, s);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('readerFor', () => {
  it('reads the core live, so one reader can be reused every frame', () => {
    let x = 0.2;
    const core = {
      getFeatures: () => features({ centroid: { x, y: 0.5 } }),
      getHandState: () => state(),
    };
    const read = readerFor(core);
    expect(read('Right').features!.centroid.x).toBe(0.2);
    x = 0.8;
    expect(read('Right').features!.centroid.x).toBe(0.8);
  });
});

describe('the whole plan', () => {
  it('defaults make one-shots only — nothing drones by default', () => {
    const cfg = defaultSoundConfig();
    const out = planSound(cfg, [ev({ type: 'pose', name: 'fist' })], reader({ Right: {} }));
    expect(out.every((a) => a.kind === 'play')).toBe(true);
    expect(out).toHaveLength(1);
  });

  it('defaults are a copy, not a shared object', () => {
    const a = defaultSoundConfig();
    a.cues.length = 0;
    expect(defaultSoundConfig().cues.length).toBeGreaterThan(0);
  });
});

describe('GestureSound config', () => {
  const silent = { setVolume() {}, apply() {}, get running() { return false; } } as unknown as SoundEngine;

  it('refuses an unreadable note up front, and keeps the old config', () => {
    const sound = new GestureSound({}, silent);
    const before = sound.getConfig();
    expect(() => sound.setConfig({ cues: [{ on: 'engage', sound: 'blip', note: 'H9' }] })).toThrow(/not a note/);
    expect(sound.getConfig()).toEqual(before);
    expect(() => new GestureSound({ controls: [{ ...THEREMIN[0]!, root: 'nope' }] }, silent)).toThrow(/root/);
  });
});

describe('planNotes', () => {
  const voices = (a: SoundAction[]) => a.filter((x): x is Extract<SoundAction, { kind: 'voice' }> => x.kind === 'voice');

  it('sounds every note as its own sustained voice', () => {
    const out = voices(planNotes([69, 73, 76]));

    expect(out.map((v) => v.on)).toEqual([true, true, true]);
    expect(out.map((v) => Math.round(v.frequency))).toEqual([440, 554, 659]);
  });

  it('names the voices by slot, so a chord change glides instead of restarting', () => {
    const first = voices(planNotes([69, 73, 76])).map((v) => v.voice);
    const second = voices(planNotes([71, 74, 78])).map((v) => v.voice);

    expect(first).toEqual(second);
  });

  it('silences the slots a shorter chord does not use', () => {
    const out = voices(planNotes([69]));

    expect(out.map((v) => v.on)).toEqual([true, false, false]);
  });

  it('silences everything when nothing is held', () => {
    expect(voices(planNotes([])).every((v) => !v.on)).toBe(true);
  });

  it('shares the gain out, so a triad is not three times as loud as one note', () => {
    const one = voices(planNotes([69]))[0]!;
    const three = voices(planNotes([69, 73, 76]))[0]!;

    expect(three.gain).toBeCloseTo(one.gain / 3, 6);
  });

  it('takes more notes than the default three when asked', () => {
    expect(voices(planNotes([60, 64, 67, 71], { slots: 4 })).filter((v) => v.on)).toHaveLength(4);
  });
});

describe('GestureSound.holdNotes', () => {
  /** A stub that runs, and remembers what it was told to do. */
  function recorder() {
    const applied: SoundAction[][] = [];
    const engine = {
      setVolume() {},
      apply(a: readonly SoundAction[]) { applied.push([...a]); },
      get running() { return true; },
    } as unknown as SoundEngine;
    return { engine, applied };
  }

  it('hands the notes to the engine as voices', () => {
    const { engine, applied } = recorder();

    new GestureSound({}, engine).holdNotes([69, 73, 76]);

    const on = applied.at(-1)!.filter((a) => a.kind === 'voice' && a.on);
    expect(on).toHaveLength(3);
  });

  it('does nothing while the engine is stopped', () => {
    const applied: SoundAction[][] = [];
    const stopped = {
      setVolume() {},
      apply(a: readonly SoundAction[]) { applied.push([...a]); },
      get running() { return false; },
    } as unknown as SoundEngine;

    new GestureSound({}, stopped).holdNotes([69]);

    expect(applied).toEqual([]);
  });

  it('silences the chord when handed nothing', () => {
    const { engine, applied } = recorder();

    new GestureSound({}, engine).holdNotes([]);

    expect(applied.at(-1)!.every((a) => a.kind === 'voice' && !a.on)).toBe(true);
  });
});

describe('only the engine touches the browser', () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const banned = /\b(AudioContext|window|document|navigator|setTimeout|requestAnimationFrame)\b/;
  for (const file of readdirSync(src).filter((f) => f !== 'engine.ts' && f !== 'index.ts')) {
    it(`${file} is pure`, () => {
      const code = readFileSync(src + file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(banned);
    });
  }
});
