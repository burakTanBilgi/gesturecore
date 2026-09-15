import { describe, expect, it } from 'vitest';
import { GestureCore } from '../src/index.js';
import { motionProgress, type MotionSample } from '../src/motions/detect.js';
import type { GestureCoreConfigPatch, GestureEvent, Hand, Landmark, MotionDescription } from '../src/types.js';
import { hand, loadFixture, rotate, scale, translate, withPinchRaw } from './helpers.js';

// ── pure detection ──────────────────────────────────────────────────────────

/** Samples with span 0.2 so one span = 0.2 units. `xs` are in spans. */
function samples(xs: number[], opts: { dt?: number; t0?: number; pose?: string | null; axis?: 'x' | 'y' } = {}): MotionSample[] {
  const { dt = 33, t0 = 0, pose = null, axis = 'x' } = opts;
  return xs.map((v, i) => ({
    t: t0 + i * dt,
    x: axis === 'x' ? v * 0.2 : 0.5,
    y: axis === 'y' ? v * 0.2 : 0.5,
    span: 0.2,
    tilt: 0,
    pose,
  }));
}

const SWIPE: MotionDescription = { name: 's', axis: 'x', direction: 1, distance: 1, withinMs: 400 };

describe('motionProgress: single stroke', () => {
  it('reports travel / distance, reaching 1 exactly at the distance', () => {
    expect(motionProgress(samples([0, 0.25, 0.5]), SWIPE, -Infinity)).toBeCloseTo(0.5, 9);
    expect(motionProgress(samples([0, 0.5, 1]), SWIPE, -Infinity)).toBeCloseTo(1, 9);
    expect(motionProgress(samples([0, 0.5, 2]), SWIPE, -Infinity)).toBe(1);
  });

  it('measures from the lowest point in the window, not the first sample', () => {
    expect(motionProgress(samples([0.5, -0.5, 0.5]), SWIPE, -Infinity)).toBeCloseTo(1, 9);
  });

  it('respects direction', () => {
    expect(motionProgress(samples([0, 1]), { ...SWIPE, direction: -1 }, -Infinity)).toBe(0);
    expect(motionProgress(samples([1, 0]), { ...SWIPE, direction: -1 }, -Infinity)).toBeCloseTo(1, 9);
  });

  it('too slow: travel spread over more than withinMs does not count', () => {
    const slow = samples([0, 0.2, 0.4, 0.6, 0.8, 1.0], { dt: 100 }); // 500 ms for the whole stroke
    expect(motionProgress(slow, SWIPE, -Infinity)).toBeLessThan(1);
    const fast = samples([0, 0.2, 0.4, 0.6, 0.8, 1.0], { dt: 80 }); // 400 ms
    expect(motionProgress(fast, SWIPE, -Infinity)).toBeCloseTo(1, 9);
  });

  it('ignores samples before `since`', () => {
    expect(motionProgress(samples([0, 0.5, 1]), SWIPE, 33)).toBeCloseTo(0.5, 9);
  });

  it('measures in spans: the same stroke of a smaller (farther) hand counts the same', () => {
    const far = samples([0, 0.5, 1]).map((s) => ({ ...s, x: s.x / 2, span: s.span / 2 }));
    expect(motionProgress(far, SWIPE, -Infinity)).toBeCloseTo(1, 9);
  });

  it('y axis: +1 is down the frame', () => {
    const down = samples([0, 1], { axis: 'y' });
    expect(motionProgress(down, { ...SWIPE, axis: 'y' }, -Infinity)).toBeCloseTo(1, 9);
    expect(motionProgress(down, { ...SWIPE, axis: 'y', direction: -1 }, -Infinity)).toBe(0);
  });

  it('depth: distance is relative growth of span', () => {
    const push = [0.2, 0.22, 0.25].map((span, i) => ({ t: i * 33, x: 0.5, y: 0.5, span, tilt: 0, pose: null }));
    const m: MotionDescription = { name: 'push', axis: 'depth', direction: 1, distance: 0.25, withinMs: 500 };
    expect(motionProgress(push, m, -Infinity)).toBeCloseTo(1, 9);
    expect(motionProgress(push.slice(0, 2), m, -Infinity)).toBeCloseTo(Math.log(1.1) / Math.log(1.25), 9);
    expect(motionProgress(push, { ...m, direction: -1 }, -Infinity)).toBe(0);
  });

  it('tilt: unwraps through ±π', () => {
    const tilts = [3.0, 3.1, -3.1, -3.0]; // +0.28 rad, crossing π
    const s = tilts.map((tilt, i) => ({ t: i * 33, x: 0.5, y: 0.5, span: 0.2, tilt, pose: null }));
    const m: MotionDescription = { name: 'twist', axis: 'tilt', direction: 1, distance: 0.25, withinMs: 500 };
    expect(motionProgress(s, m, -Infinity)).toBe(1);
  });

  it('pose: only the unbroken run holding the pose counts', () => {
    const s = samples([0, 0.5, 1]);
    s[0]!.pose = 'fist';
    s[1]!.pose = 'openPalm';
    s[2]!.pose = 'openPalm';
    const m = { ...SWIPE, pose: 'openPalm' };
    expect(motionProgress(s, m, -Infinity)).toBeCloseTo(0.5, 9);
    s[2]!.pose = 'fist';
    expect(motionProgress(s, m, -Infinity)).toBe(0);
  });

  it('is 0 with fewer than two samples and for an unknown axis', () => {
    expect(motionProgress([], SWIPE, -Infinity)).toBe(0);
    expect(motionProgress(samples([5]), SWIPE, -Infinity)).toBe(0);
    expect(motionProgress(samples([0, 5]), { ...SWIPE, axis: 'nope' as 'x' }, -Infinity)).toBe(0);
  });
});

describe('motionProgress: reversals (waves)', () => {
  const WAVE: MotionDescription = { name: 'w', axis: 'x', distance: 0.5, withinMs: 2000, reversals: 3 };

  it('needs reversals + 1 strokes of at least `distance`', () => {
    expect(motionProgress(samples([0, 0.5, 0, 0.5, 0]), WAVE, -Infinity)).toBe(1); // 4 strokes
    expect(motionProgress(samples([0, 0.5, 0, 0.5]), WAVE, -Infinity)).toBeCloseTo(0.75, 9); // 3 strokes
  });

  it('may start in either direction', () => {
    expect(motionProgress(samples([0, -0.5, 0, -0.5, 0]), WAVE, -Infinity)).toBe(1);
  });

  it('small wiggles do not count as strokes', () => {
    expect(motionProgress(samples([0, 0.3, 0, 0.3, 0, 0.3, 0, 0.3, 0]), WAVE, -Infinity)).toBeLessThan(0.25);
  });

  it('a stroke may continue past the distance before reversing', () => {
    expect(motionProgress(samples([0, 0.5, 1.2, 0.6, 1.1, 0.5]), WAVE, -Infinity)).toBe(1);
  });
});

// ── through GestureCore ─────────────────────────────────────────────────────

const OPEN = loadFixture('open');
const FIST = loadFixture('fist');
// 1e15 Hz: residual filter lag (~1e-17) stays far below the detector's 1e-9 tolerance at exact thresholds.
const NO_SMOOTHING = { smoothing: { minCutoff: 1e15, beta: 0, dCutoff: 1 } };
const ALWAYS: GestureCoreConfigPatch = { ...NO_SMOOTHING, engage: { pose: '' } };
const R = (pts: Landmark[]): Hand[] => [hand(pts, 'Right')];
/** The open fixture's actual span, so "N spans" in these tests is exact. */
const SPAN = Math.hypot(OPEN[9]!.x - OPEN[0]!.x, OPEN[9]!.y - OPEN[0]!.y, OPEN[9]!.z - OPEN[0]!.z);

/** Frames every 33 ms moving the hand along x by `spans` total, over `ms`. */
function stroke(base: Landmark[], fromSpans: number, toSpans: number, t0: number, ms: number): [number, Hand[]][] {
  const n = Math.max(1, Math.round(ms / 33));
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = fromSpans + ((toSpans - fromSpans) * i) / n;
    return [t0 + (ms * i) / n, R(translate(base, s * SPAN, 0))] as [number, Hand[]];
  });
}

const run = (core: GestureCore, frames: [number, Hand[]][]) => frames.flatMap(([t, h]) => core.update(h, t));
const motions = (events: GestureEvent[]) => events.filter((e) => e.type === 'motion').map((e) => `${(e as { name: string }).name}@${e.t}`);

describe('motions in GestureCore', () => {
  it('a fast swipe right fires swipeRight once; swipe left fires swipeLeft', () => {
    const core = new GestureCore(ALWAYS);
    const right = run(core, stroke(OPEN, 0, 2, 0, 300));
    expect(motions(right)).toHaveLength(1);
    expect(motions(right)[0]).toMatch(/^swipeRight@/);
    const left = run(core, stroke(OPEN, 2, 0, 1300, 300));
    expect(motions(left).map((m) => m.split('@')[0])).toEqual(['swipeLeft']);
  });

  it('fires at the frame the distance is reached (1.5 spans)', () => {
    const core = new GestureCore(ALWAYS);
    const frames: [number, Hand[]][] = [0, 0.5, 1.0, 1.4999, 1.5].map((s, i) => [i * 50, R(translate(OPEN, s * SPAN, 0))]);
    expect(motions(run(core, frames))).toEqual(['swipeRight@200']);
  });

  it('a slow drift of the same distance does not fire', () => {
    const core = new GestureCore(ALWAYS);
    expect(motions(run(core, stroke(OPEN, 0, 3, 0, 2000)))).toEqual([]);
  });

  it('does not fire while not engaged, and movement from before engaging does not count', () => {
    const core = new GestureCore({ ...NO_SMOOTHING, engage: { pose: 'openPalm', dwellMs: 500 } });
    expect(motions(run(core, stroke(FIST, 0, 3, 0, 300)))).toEqual([]);
    const events = run(core, [
      ...stroke(OPEN, 0, 0, 400, 500), // engage at 900
      ...stroke(OPEN, 0, 2, 933, 250),
    ]);
    expect(events.find((e) => e.type === 'engage')?.t).toBe(900);
    expect(motions(events)).toHaveLength(1);
    expect(motions(events)[0]).toMatch(/^swipeRight@11/);
  });

  it('does not fire during a pinch-drag, nor from the drag movement right after release', () => {
    const core = new GestureCore({ ...ALWAYS, dwellMs: 0 });
    const pinched = withPinchRaw(OPEN, 0.1);
    const drag = stroke(pinched, 0, 3, 0, 300);
    const events = run(core, [...drag, [333, R(translate(OPEN, 3 * SPAN, 0))], [366, R(translate(OPEN, 3 * SPAN, 0))]]);
    expect(events.some((e) => e.type === 'pinch:start')).toBe(true);
    expect(motions(events)).toEqual([]);
  });

  it('a wave needs the open palm and four strokes', () => {
    const core = new GestureCore(ALWAYS);
    const waveFrames = [
      ...stroke(OPEN, 0, 0.8, 0, 400),
      ...stroke(OPEN, 0.8, 0, 433, 400),
      ...stroke(OPEN, 0, 0.8, 866, 400),
      ...stroke(OPEN, 0.8, 0, 1299, 400),
    ];
    expect(motions(run(core, waveFrames)).map((m) => m.split('@')[0])).toEqual(['wave']);
    const fistCore = new GestureCore(ALWAYS);
    const fistWave = waveFrames.map(([t, h]) => [t, R(translate(FIST, h[0]!.landmarks[0]!.x - OPEN[0]!.x, 0))] as [number, Hand[]]);
    expect(motions(run(fistCore, fistWave))).toEqual([]);
  });

  it('cooldown and used-up movement: one long fast stroke fires once', () => {
    const core = new GestureCore({ ...ALWAYS, motions: [{ name: 'r', axis: 'x', direction: 1, distance: 1, withinMs: 1000, cooldownMs: 0 }] });
    expect(motions(run(core, stroke(OPEN, 0, 1.9, 0, 300)))).toHaveLength(1);
    // continuing another full span fires again (cooldown 0, fresh movement)
    expect(motions(run(core, stroke(OPEN, 1.9, 3.0, 333, 150)))).toHaveLength(1);
  });

  it('cooldownMs blocks a second fire', () => {
    const core = new GestureCore({ ...ALWAYS, motions: [{ name: 'r', axis: 'x', direction: 1, distance: 1, withinMs: 1000, cooldownMs: 5000 }] });
    expect(motions(run(core, [...stroke(OPEN, 0, 1.1, 0, 150), ...stroke(OPEN, 1.1, 2.5, 183, 150)]))).toHaveLength(1);
  });

  it('push (depth) and twist (tilt) are declarable as data', () => {
    const core = new GestureCore({
      ...ALWAYS,
      motions: [
        { name: 'push', axis: 'depth', direction: 1, distance: 0.3, withinMs: 500 },
        { name: 'twist', axis: 'tilt', direction: 1, distance: 0.6, withinMs: 500 },
      ],
    });
    const push = [1, 1.1, 1.2, 1.35].map((k, i) => [i * 50, R(scale(OPEN, k))] as [number, Hand[]]);
    expect(motions(run(core, push))).toEqual(['push@150']);
    const twist = [0, 0.2, 0.4, 0.7].map((r, i) => [1000 + i * 50, R(scale(rotate(OPEN, r), 1.35))] as [number, Hand[]]);
    expect(motions(run(core, twist))).toEqual(['twist@1150']);
  });

  it('exposes per-motion progress in config order', () => {
    const core = new GestureCore(ALWAYS);
    run(core, stroke(OPEN, 0, 0.75, 0, 200));
    const p = core.getHandState('Right')!.motionProgress;
    expect(p.map((m) => m.name)).toEqual(['swipeLeft', 'swipeRight', 'wave']);
    expect(p[1]!.progress).toBeCloseTo(0.5, 6);
    expect(p[0]!.progress).toBe(0);
  });

  it('motions can be replaced at runtime', () => {
    const core = new GestureCore(ALWAYS);
    core.setConfig({ motions: [{ name: 'up', axis: 'y', direction: -1, distance: 1, withinMs: 400 }] });
    const frames = [0, 0.5, 1.0].map((s, i) => [i * 50, R(translate(OPEN, 0, -s * SPAN))] as [number, Hand[]]);
    expect(motions(run(core, frames))).toEqual(['up@100']);
  });
});
