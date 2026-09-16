import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { LandmarkSmoother, OneEuroFilter, type OneEuroParams } from '../src/filter/oneEuro.js';
import { loadFixture } from './helpers.js';

const DEFAULTS = defaultConfig().smoothing;

/** Deterministic uniform noise in [-amp, amp]. */
function noise(seed: number, amp: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647 - 0.5) * 2 * amp;
  };
}

function std(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** Feed a 0→1 step at t=0 sampled at `fps`; return outputs and the time it first stays within `tol` of 1. */
function stepResponse(params: OneEuroParams, fps: number, durationMs = 2000, tol = 0.05) {
  const f = new OneEuroFilter(params);
  const dt = 1000 / fps;
  f.filter(0, -dt);
  const out: { t: number; y: number }[] = [];
  for (let t = 0; t <= durationMs; t += dt) out.push({ t, y: f.filter(1, t) });
  let settle = Number.POSITIVE_INFINITY;
  for (let i = out.length - 1; i >= 0; i--) {
    if (Math.abs(out[i]!.y - 1) > tol) break;
    settle = out[i]!.t;
  }
  return { out, settle };
}

describe('OneEuroFilter: basics', () => {
  it('passes the first sample through unchanged', () => {
    expect(new OneEuroFilter(DEFAULTS).filter(0.42, 1000)).toBe(0.42);
  });

  it('holds a constant input exactly', () => {
    const f = new OneEuroFilter(DEFAULTS);
    for (let t = 0; t < 1000; t += 16) expect(f.filter(0.3, t)).toBe(0.3);
  });

  it('ignores duplicate and backwards timestamps instead of producing NaN', () => {
    const f = new OneEuroFilter(DEFAULTS);
    f.filter(0, 0);
    const y = f.filter(1, 33);
    expect(f.filter(5, 33)).toBe(y);
    expect(f.filter(5, 10)).toBe(y);
    expect(Number.isFinite(f.filter(1, 66))).toBe(true);
  });

  it('snaps toward the new value after a long gap', () => {
    const f = new OneEuroFilter(DEFAULTS);
    f.filter(0, 0);
    expect(f.filter(1, 10_000)).toBeGreaterThan(0.95);
  });

  it('reset forgets history', () => {
    const f = new OneEuroFilter(DEFAULTS);
    f.filter(0, 0);
    f.filter(0, 16);
    f.reset();
    expect(f.filter(0.9, 32)).toBe(0.9);
  });

  it('setParams changes behaviour without resetting state', () => {
    const slow = new OneEuroFilter(DEFAULTS);
    const live = new OneEuroFilter(DEFAULTS);
    slow.filter(0, 0);
    live.filter(0, 0);
    live.setParams({ ...DEFAULTS, minCutoff: 50 });
    const a = slow.filter(1, 33);
    const b = live.filter(1, 33);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1); // not a reset, which would pass 1 straight through
  });
});

describe('OneEuroFilter: step input', () => {
  it.each([30, 60])('never overshoots and rises monotonically (%i fps)', (fps) => {
    for (const params of [DEFAULTS, { ...DEFAULTS, beta: 5 }, { ...DEFAULTS, minCutoff: 10, beta: 50 }]) {
      const { out } = stepResponse(params, fps);
      let prev = 0;
      for (const { y } of out) {
        expect(y).toBeLessThanOrEqual(1);
        expect(y).toBeGreaterThanOrEqual(prev);
        prev = y;
      }
    }
  });

  it('defaults settle within 5% in under 600 ms at 30 fps', () => {
    const { settle } = stepResponse(DEFAULTS, 30);
    expect(settle).toBeLessThan(600);
    expect(settle).toBeGreaterThan(200); // heavily smoothed: it is a ~1 Hz low-pass at these units
  });

  it('beta trades smoothing for responsiveness: larger beta settles faster', () => {
    const settles = [0.007, 1, 5, 20].map((beta) => stepResponse({ ...DEFAULTS, beta }, 30).settle);
    for (let i = 1; i < settles.length; i++) expect(settles[i]).toBeLessThan(settles[i - 1]!);
    expect(settles[3]).toBeLessThan(150);
  });

  it('larger minCutoff settles faster', () => {
    const a = stepResponse({ ...DEFAULTS, minCutoff: 1 }, 30).settle;
    const b = stepResponse({ ...DEFAULTS, minCutoff: 4 }, 30).settle;
    expect(b).toBeLessThan(a);
  });
});

describe('OneEuroFilter: noisy constant', () => {
  function jitter(params: OneEuroParams, fps: number) {
    const f = new OneEuroFilter(params);
    const n = noise(7, 0.01);
    const input: number[] = [];
    const output: number[] = [];
    const dt = 1000 / fps;
    for (let t = 0; t < 6000; t += dt) {
      const x = 0.5 + n();
      const y = f.filter(x, t);
      if (t >= 1000) {
        input.push(x);
        output.push(y);
      }
    }
    return { input, output };
  }

  it.each([30, 60])('defaults cut residual jitter to under 40%% of input at %i fps', (fps) => {
    const { input, output } = jitter(DEFAULTS, fps);
    expect(std(output) / std(input)).toBeLessThan(0.4);
    const mean = output.reduce((a, b) => a + b, 0) / output.length;
    expect(mean).toBeCloseTo(0.5, 2);
  });

  it('a very high minCutoff is effectively a passthrough (used by deterministic state tests)', () => {
    const { input, output } = jitter({ minCutoff: 1e9, beta: 0, dCutoff: 1 }, 30);
    for (let i = 0; i < input.length; i++) expect(output[i]).toBeCloseTo(input[i]!, 6);
  });
});

describe('LandmarkSmoother', () => {
  it('filters all 63 coordinates independently', () => {
    const pts = loadFixture('open');
    const s = new LandmarkSmoother(DEFAULTS);
    expect(s.filter(pts, 0)).toEqual(pts);
    const moved = pts.map((p, i) => ({ x: p.x + (i === 8 ? 0.1 : 0), y: p.y, z: p.z }));
    const out = s.filter(moved, 33);
    const ref = new OneEuroFilter(DEFAULTS);
    ref.filter(pts[8]!.x, 0);
    expect(out[8]!.x).toBe(ref.filter(moved[8]!.x, 33));
    out.forEach((p, i) => {
      if (i !== 8) expect(p).toEqual(pts[i]);
    });
  });

  it('does not mutate its input', () => {
    const pts = loadFixture('fist');
    const snap = JSON.stringify(pts);
    const s = new LandmarkSmoother(DEFAULTS);
    s.filter(pts, 0);
    s.filter(loadFixture('open'), 16);
    expect(JSON.stringify(pts)).toBe(snap);
  });
});
