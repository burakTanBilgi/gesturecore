import { describe, expect, it } from 'vitest';
import { firesWithin, fitMotion, fitPose, type MotionTake } from '../src/learn/fit.js';
import type { MotionSample } from '../src/motions/detect.js';
import { motionProgress } from '../src/motions/detect.js';

/** A demonstration: `path` gives the axis value over time, 30 fps by default. */
function take(path: (i: number, n: number) => Partial<MotionSample>, n = 30, stepMs = 33, t0 = 1000): MotionTake {
  return Array.from({ length: n }, (_, i) => ({
    t: t0 + i * stepMs,
    x: 0.5,
    y: 0.5,
    span: 0.2,
    tilt: 0,
    pose: null,
    ...path(i, n),
  }));
}

const swipeRight = (spans: number, n = 12) => take((i, len) => ({ x: 0.3 + (i / (len - 1)) * spans * 0.2 }), n);
const swipeUp = (spans: number, n = 12) => take((i, len) => ({ y: 0.8 - (i / (len - 1)) * spans * 0.2 }), n);
const wave = (strokes: number, size: number, n = 60) =>
  take((i, len) => ({ x: 0.5 + Math.sin((i / (len - 1)) * Math.PI * strokes) * size * 0.2 }), n);
const still = (n = 40) => take((i) => ({ x: 0.5 + Math.sin(i / 7) * 0.004 }), n);

describe('fitPose', () => {
  const hold = (curls: number[], jitter = 0.01) =>
    Array.from({ length: 12 }, (_, i) => ({ curls: curls.map((c) => c + Math.sin(i) * jitter) }));

  it('turns a held shape into ranges around what was seen', () => {
    const { pose } = fitPose('thumbsUp', hold([0.1, 0.9, 0.9, 0.9, 0.9]));
    expect(pose.name).toBe('thumbsUp');
    expect(pose.fingers.thumb?.curl?.[0]).toBeLessThanOrEqual(0.1);
    expect(pose.fingers.thumb?.curl?.[1]).toBeGreaterThanOrEqual(0.1);
    expect(pose.fingers.index?.curl?.[0]).toBeLessThanOrEqual(0.9);
    expect(pose.fingers.pinky?.curl?.[1]).toBeGreaterThanOrEqual(0.9);
  });

  it('leaves a finger out when it did not stay put', () => {
    const samples = hold([0.1, 0.9, 0.9, 0.9, 0.9]).map((s, i) => ({ curls: [...s.curls.slice(0, 4), i % 2 ? 0.05 : 0.95] }));
    const fit = fitPose('waggle', samples);
    expect(fit.ignored).toContain('pinky');
    expect(fit.pose.fingers.pinky).toBeUndefined();
    expect(fit.pose.fingers.index).toBeDefined();
  });

  it('records what it actually saw, before the margin', () => {
    const fit = fitPose('x', [{ curls: [0.2, 0.2, 0.2, 0.2, 0.2] }, { curls: [0.3, 0.3, 0.3, 0.3, 0.3] }]);
    expect(fit.observed.index).toEqual({ lo: 0.2, hi: 0.3 });
    expect(fit.pose.fingers.index?.curl).toEqual([0.12, 0.38]);
  });

  it('a wider hold gives a wider range', () => {
    const tight = fitPose('a', hold([0.5, 0.5, 0.5, 0.5, 0.5], 0.01)).pose.fingers.index!.curl!;
    const loose = fitPose('b', hold([0.5, 0.5, 0.5, 0.5, 0.5], 0.1)).pose.fingers.index!.curl!;
    expect(loose[1] - loose[0]).toBeGreaterThan(tight[1] - tight[0]);
  });

  it('refuses an empty demonstration', () => {
    expect(() => fitPose('nothing', [])).toThrow(/at least one/);
  });
});

describe('fitMotion', () => {
  it('learns a sideways swipe and fires on the takes it came from', () => {
    const fit = fitMotion('swipeRight', [swipeRight(1.6), swipeRight(1.8), swipeRight(2.0)]);
    expect(fit.motion.axis).toBe('x');
    expect(fit.motion.direction).toBe(1);
    expect(fit.motion.reversals).toBeUndefined();
    expect(fit.takes.every((s) => s >= 1)).toBe(true);
  });

  it('keeps the threshold under the smallest demonstration', () => {
    const fit = fitMotion('swipeRight', [swipeRight(1.5), swipeRight(3)]);
    expect(fit.motion.distance).toBeLessThan(1.5);
    expect(fit.motion.distance).toBeGreaterThan(0.5);
  });

  it('learns direction from the demonstration', () => {
    expect(fitMotion('up', [swipeUp(1.6), swipeUp(1.7)]).motion.direction).toBe(-1);
    expect(fitMotion('up', [swipeUp(1.6), swipeUp(1.7)]).motion.axis).toBe('y');
  });

  it('counts the strokes of a wave', () => {
    const fit = fitMotion('wave', [wave(4, 0.8), wave(4, 0.9)]);
    expect(fit.motion.axis).toBe('x');
    expect(fit.motion.reversals).toBeGreaterThanOrEqual(2);
    expect(fit.takes.every((s) => s >= 1)).toBe(true);
  });

  it('learns a push as depth, not as sideways drift', () => {
    const push = take((i, len) => ({ span: 0.16 * (1 + (i / (len - 1)) * 0.5), x: 0.5 + i * 0.001 }), 14);
    const fit = fitMotion('push', [push, push]);
    expect(fit.motion.axis).toBe('depth');
    expect(fit.takes.every((s) => s >= 1)).toBe(true);
  });

  it('learns a twist as tilt', () => {
    const twist = take((i, len) => ({ tilt: (i / (len - 1)) * 1.2 }), 14);
    const fit = fitMotion('twist', [twist, twist]);
    expect(fit.motion.axis).toBe('tilt');
    expect(fit.takes.every((s) => s >= 1)).toBe(true);
  });

  it('allows a little longer than the slowest take', () => {
    const slow = swipeRight(1.8, 30); // 30 frames ≈ 957 ms
    const fit = fitMotion('slow', [swipeRight(1.8, 12), slow]);
    const slowMs = slow[slow.length - 1]!.t - slow[0]!.t;
    expect(fit.motion.withinMs).toBeGreaterThan(slowMs);
  });

  it('reports how clearly one axis won', () => {
    const clean = fitMotion('clean', [swipeRight(2), swipeRight(2)]);
    expect(clean.margin).toBeGreaterThan(2);
  });

  it('carries a required pose into the fit', () => {
    const fit = fitMotion('wave', [wave(4, 0.8)], { pose: 'openPalm' });
    expect(fit.motion.pose).toBe('openPalm');
  });

  it('refuses a demonstration with nothing in it', () => {
    expect(() => fitMotion('nothing', [[]])).toThrow(/at least two samples/);
  });

  it('what it learns does not fire on a hand holding still', () => {
    const fit = fitMotion('swipeRight', [swipeRight(1.6), swipeRight(1.8)]);
    expect(firesWithin(fit.motion, still())).toBe(false);
    expect(motionProgress(still(), fit.motion, -Infinity)).toBeLessThan(1);
  });

  it('a swipe learnt one way does not fire on the opposite swipe', () => {
    const fit = fitMotion('swipeRight', [swipeRight(1.6), swipeRight(1.8)]);
    const left = take((i, len) => ({ x: 0.9 - (i / (len - 1)) * 1.8 * 0.2 }), 12);
    expect(firesWithin(fit.motion, left)).toBe(false);
  });
});
