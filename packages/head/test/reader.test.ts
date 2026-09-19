import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPRESSIONS, defaultHeadConfig } from '../src/defaults.js';
import { HeadReader } from '../src/index.js';
import { faceFromMediaPipe } from '../src/mediapipe.js';
import { channels, closure } from '../src/readings.js';
import type { Face, HeadEvent, HeadReaderConfigPatch } from '../src/types.js';
import { synthFace, type Synth } from './helpers.js';

const FPS = 30;
const dt = 1000 / FPS;

/** Runs a sequence of frames through a fresh reader and returns every event, with the reader. */
function run(script: ((i: number, t: number) => Face | null)[] | ((i: number, t: number) => Face | null), n?: number, cfg: HeadReaderConfigPatch = {}) {
  const head = new HeadReader(cfg);
  const events: HeadEvent[] = [];
  const count = Array.isArray(script) ? script.length : n!;
  for (let i = 0; i < count; i++) {
    const t = i * dt;
    const make = Array.isArray(script) ? script[i]! : script;
    events.push(...head.update(make(i, t), t));
  }
  return { head, events };
}

/** `ms` of frames holding one synthetic face. */
const hold = (o: Synth, ms: number) => Array.from({ length: Math.round(ms / dt) }, () => () => synthFace(o));
const none = (ms: number) => Array.from({ length: Math.round(ms / dt) }, () => () => null);
const names = (events: HeadEvent[], type: HeadEvent['type']) => events.filter((e) => e.type === type).map((e) => ('name' in e ? e.name : e.type));

describe('found and lost', () => {
  it('announces a face on its first frame and loses it after lostAfterMs', () => {
    const { events } = run([...hold({}, 300), ...none(500)]);
    expect(events[0]).toEqual({ type: 'face', t: 0 });
    const lost = events.find((e) => e.type === 'lost')!;
    expect(lost).toBeDefined();
    expect(lost.t).toBeGreaterThan(300 + 300 - dt);
  });

  it('a short dropout is not a loss', () => {
    const { events } = run([...hold({}, 300), ...none(150), ...hold({}, 300)]);
    expect(names(events, 'face')).toHaveLength(1);
    expect(names(events, 'lost')).toHaveLength(0);
  });

  it('rejects a face with too few landmarks as no face at all', () => {
    const head = new HeadReader();
    expect(head.update({ landmarks: synthFace().landmarks.slice(0, 100) }, 0)).toEqual([]);
    expect(head.getReadings()).toBeNull();
  });

  it('ends every active expression before announcing the loss', () => {
    const { events } = run([...hold({ roll: 30 }, 600), ...none(500)]);
    const types = events.map((e) => e.type);
    expect(types.indexOf('expression:end')).toBeLessThan(types.indexOf('lost'));
    const end = events.find((e) => e.type === 'expression:end' && e.name === 'tiltRight');
    expect(end).toBeDefined();
  });

  it('ignores a frame from the past', () => {
    const head = new HeadReader();
    head.update(synthFace(), 100);
    expect(head.update(synthFace({ roll: 40 }), 50)).toEqual([]);
  });
});

describe('expressions', () => {
  it('a held tilt starts after its dwell, once, and ends when released', () => {
    const { events } = run([...hold({}, 300), ...hold({ roll: 30 }, 900), ...hold({}, 600)]);
    const starts = events.filter((e) => e.type === 'expression:start');
    expect(starts.map((e) => (e as { name: string }).name)).toEqual(['tiltRight']);
    const end = events.find((e) => e.type === 'expression:end')! as Extract<HeadEvent, { type: 'expression:end' }>;
    expect(end.name).toBe('tiltRight');
    expect(end.heldMs).toBeGreaterThan(500);
  });

  it('tilting the other way is tiltLeft; turning and looking have their own names', () => {
    const got = (o: Synth) => names(run([...hold({}, 200), ...hold(o, 1000)]).events, 'expression:start');
    expect(got({ roll: -30 })).toEqual(['tiltLeft']);
    expect(got({ yaw: 35 })).toEqual(['turnRight']);
    expect(got({ yaw: -35 })).toEqual(['turnLeft']);
    expect(got({ pitch: 25 })).toEqual(['lookUp']);
    expect(got({ pitch: -25 })).toEqual(['lookDown']);
  });

  it('a mirrored frame declared as mirrored names sides the same way', () => {
    const got = (o: Synth) => names(run([...hold(o, 1000)], undefined, { mirrored: true }).events, 'expression:start');
    expect(got({ yaw: 35, mirrored: true })).toEqual(['turnRight']);
    expect(got({ roll: -30, mirrored: true })).toEqual(['tiltLeft']);
  });

  it('hysteresis: once tilted, resting just inside the release margin stays active', () => {
    // enter at 20° (> 15), then settle at 13° (< 15 but within the 4° margin)
    const { events } = run([...hold({ roll: 20 }, 800), ...hold({ roll: 13 }, 800)]);
    expect(names(events, 'expression:start')).toEqual(['tiltRight']);
    expect(names(events, 'expression:end')).toEqual([]);
  });

  it('a blink needs no hold; a wink must outlast one', () => {
    const blink = run([...hold({}, 300), ...hold({ earLeft: 0.08, earRight: 0.08 }, 100), ...hold({}, 300)]).events;
    expect(names(blink, 'expression:start')).toEqual(['blink']);
    expect(names(blink, 'expression:end')).toEqual(['blink']);

    const quick = run([...hold({}, 300), ...hold({ earLeft: 0.08 }, 100), ...hold({}, 300)]).events;
    expect(names(quick, 'expression:start')).toEqual([]);

    const wink = run([...hold({}, 300), ...hold({ earLeft: 0.08 }, 400), ...hold({}, 300)]).events;
    expect(names(wink, 'expression:start')).toEqual(['winkLeft']);
  });

  it('the wink is named for the anatomical eye, mirrored or not', () => {
    const raw = run([...hold({ earRight: 0.08 }, 500)]).events;
    const mirrored = run([...hold({ earRight: 0.08, mirrored: true }, 500)], undefined, { mirrored: true }).events;
    expect(names(raw, 'expression:start')).toEqual(['winkRight']);
    expect(names(mirrored, 'expression:start')).toEqual(['winkRight']);
  });

  it('brows, frown, mouth and smile come from blendshapes', () => {
    const bs = (over: Record<string, number>) => ({
      browInnerUp: 0.1, browOuterUpLeft: 0.1, browOuterUpRight: 0.1, browDownLeft: 0, browDownRight: 0,
      jawOpen: 0.05, mouthSmileLeft: 0, mouthSmileRight: 0, ...over,
    });
    const got = (over: Record<string, number>) => names(run([...hold({ blendshapes: bs({}) }, 200), ...hold({ blendshapes: bs(over) }, 600)]).events, 'expression:start');
    expect(got({ browInnerUp: 0.8 })).toEqual(['browRaise']);
    expect(got({ browOuterUpLeft: 0.7, browOuterUpRight: 0.6 })).toEqual(['browRaise']);
    expect(got({ browDownLeft: 0.6, browDownRight: 0.5 })).toEqual(['frown']);
    expect(got({ jawOpen: 0.6 })).toEqual(['mouthOpen']);
    expect(got({ mouthSmileLeft: 0.7, mouthSmileRight: 0.8 })).toEqual(['smile']);
  });

  it('without blendshapes those expressions simply never fire', () => {
    const { head, events } = run([...hold({}, 1000)]);
    expect(events.filter((e) => e.type === 'expression:start')).toEqual([]);
    expect(head.getReadings()!.brows).toBeUndefined();
  });

  it('an expression may use any raw blendshape by name', () => {
    const { events } = run([...hold({ blendshapes: { cheekPuff: 0.9 } }, 600)], undefined, {
      expressions: [{ name: 'puff', when: { cheekPuff: [0.5, 1] } }],
    });
    expect(names(events, 'expression:start')).toEqual(['puff']);
  });

  it('getState shows the dwell filling', () => {
    const head = new HeadReader();
    head.update(synthFace({ roll: 30 }), 0);
    head.update(synthFace({ roll: 30 }), 125);
    const tilt = head.getState().expressions.find((e) => e.name === 'tiltRight')!;
    expect(tilt.inside).toBe(true);
    expect(tilt.active).toBe(false);
    expect(tilt.progress).toBeCloseTo(0.5, 6);
  });
});

describe('motions', () => {
  const wave = (axis: 'yaw' | 'pitch', amp: number, hz: number, cycles: number) => (i: number) => {
    const t = (i * dt) / 1000;
    const v = t < cycles / hz ? amp * Math.sin(2 * Math.PI * hz * t) : 0;
    return synthFace({ [axis]: v });
  };

  it('a nod — down and back up — fires once', () => {
    // one dip of 15° over half a second
    const nod = (i: number) => {
      const t = (i * dt) / 1000;
      return synthFace({ pitch: t < 0.5 ? -15 * Math.sin(Math.PI * (t / 0.5)) : 0 });
    };
    const { events } = run(nod, 45);
    expect(names(events, 'motion')).toEqual(['nod']);
  });

  it('a shake fires shake, not nod', () => {
    const { events } = run(wave('yaw', 20, 2, 1.5), 60);
    expect(names(events, 'motion')).toEqual(['shake']);
  });

  it('slow drift and stillness fire nothing', () => {
    const drift = (i: number) => synthFace({ yaw: (i * dt) / 100, pitch: -(i * dt) / 200 });
    expect(names(run(drift, 90).events, 'motion')).toEqual([]);
    expect(names(run([...hold({}, 3000)]).events, 'motion')).toEqual([]);
  });

  it('a small twitch is below the distance', () => {
    const { events } = run(wave('pitch', 3, 2, 2), 60);
    expect(names(events, 'motion')).toEqual([]);
  });
});

describe('calibration', () => {
  it('makes the current pose read zero', () => {
    const head = new HeadReader();
    let t = 0;
    for (let i = 0; i < 30; i++, t += dt) head.update(synthFace({ yaw: 15, pitch: -8 }), t);
    expect(head.calibrate()).toBe(true);
    head.update(synthFace({ yaw: 15, pitch: -8 }), t);
    const r = head.getReadings()!;
    expect(Math.abs(r.yaw)).toBeLessThan(0.5);
    expect(Math.abs(r.pitch)).toBeLessThan(0.5);
  });

  it('measures the resting eye, so a narrow-eyed face is not read as blinking', () => {
    const head = new HeadReader();
    let t = 0;
    for (let i = 0; i < 10; i++, t += dt) head.update(synthFace({ earLeft: 0.2, earRight: 0.2 }), t);
    expect(head.getReadings()!.blinkLeft).toBeGreaterThan(0.4);
    head.calibrate();
    head.update(synthFace({ earLeft: 0.2, earRight: 0.2 }), t);
    expect(head.getReadings()!.blinkLeft).toBe(0);
    expect(head.getNeutral().eyeLeft).toBeCloseTo(0.2, 6);
  });

  it('refuses without a face', () => {
    expect(new HeadReader().calibrate()).toBe(false);
  });
});

describe('config', () => {
  it('rejects what it cannot use, before changing anything', () => {
    const head = new HeadReader();
    expect(() => head.setConfig({ aspect: 0 })).toThrow(/aspect/);
    expect(() => head.setConfig({ expressions: [{ name: 'x', when: { yaw: [10, -10] } }] })).toThrow(/range/);
    expect(() => head.setConfig({ motions: [{ name: 'x', axis: 'x' as 'yaw', distance: 1, withinMs: 100 }] })).toThrow(/axis/);
    expect(head.getConfig().aspect).toBe(1);
  });

  it('patches nested settings without dropping their siblings', () => {
    const head = new HeadReader({ eyes: { closed: 0.1 } });
    expect(head.getConfig().eyes).toEqual({ open: defaultHeadConfig().eyes.open, closed: 0.1 });
  });

  it('getConfig is a copy', () => {
    const head = new HeadReader();
    head.getConfig().expressions.length = 0;
    expect(head.getConfig().expressions).toHaveLength(DEFAULT_EXPRESSIONS.length);
  });
});

describe('helpers', () => {
  it('closure maps the eye aspect ratio to 0 open … 1 shut', () => {
    expect(closure(0.3, 0.28, 0.12)).toBe(0);
    expect(closure(0.12, 0.28, 0.12)).toBe(1);
    expect(closure(0.2, 0.28, 0.12)).toBeCloseTo(0.5, 9);
  });

  it('channels averages the two sides and passes raw blendshapes through', () => {
    const c = channels({ browInnerUp: 0.2, browOuterUpLeft: 0.6, browOuterUpRight: 0.4, mouthSmileLeft: 0.2, mouthSmileRight: 0.4, jawOpen: 0.3 });
    expect(c.brows).toBeCloseTo(0.5, 9);
    expect(c.smile).toBeCloseTo(0.3, 9);
    expect(c.mouthOpen).toBe(0.3);
    expect(c.frown).toBeUndefined();
    expect(c.browInnerUp).toBe(0.2);
  });

  it('faceFromMediaPipe takes one face and its blendshapes, minus _neutral', () => {
    const landmarks = synthFace().landmarks;
    const face = faceFromMediaPipe({
      faceLandmarks: [landmarks],
      faceBlendshapes: [{ categories: [{ categoryName: '_neutral', score: 1 }, { categoryName: 'jawOpen', score: 0.4 }] }],
    });
    expect(face).toEqual({ landmarks, blendshapes: { jawOpen: 0.4 } });
    expect(faceFromMediaPipe({ faceLandmarks: [] })).toBeNull();
    expect(faceFromMediaPipe({ faceLandmarks: [landmarks] })).toEqual({ landmarks });
  });
});
