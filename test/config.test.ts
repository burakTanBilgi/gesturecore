import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, defaultConfig, mergeConfig } from '../src/config.js';
import type { GestureCoreConfigPatch } from '../src/types.js';

describe('config', () => {
  it('ships the specified defaults', () => {
    const c = defaultConfig();
    expect(c.smoothing).toEqual({ minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 });
    expect(c.pinch).toEqual({ closed: 0.15, open: 0.75, hysteresis: 0.05 });
    expect(c.dwellMs).toBe(300);
    expect(c.lostAfterMs).toBe(150);
    expect(c.poses.map((p) => p.name)).toEqual(['fist', 'openPalm', 'point']);
  });

  it('round-trips through JSON unchanged (flat and serialisable)', () => {
    const c = defaultConfig();
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it('defaultConfig returns an independent copy', () => {
    const a = defaultConfig();
    a.pinch.closed = 99;
    a.poses.pop();
    expect(defaultConfig().pinch.closed).toBe(0.15);
    expect(defaultConfig().poses).toHaveLength(3);
    expect(DEFAULT_CONFIG.pinch.closed).toBe(0.15);
  });

  it('merges sections one level deep without mutating inputs', () => {
    const base = defaultConfig();
    const patch = { pinch: { closed: 0.2 }, dwellMs: 400 };
    const snapshot = JSON.stringify(base);
    const merged = mergeConfig(base, patch);
    expect(merged.pinch).toEqual({ closed: 0.2, open: 0.75, hysteresis: 0.05 });
    expect(merged.dwellMs).toBe(400);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(patch).toEqual({ pinch: { closed: 0.2 }, dwellMs: 400 });
  });

  it('replaces poses wholesale', () => {
    const merged = mergeConfig(defaultConfig(), { poses: [{ name: 'x', fingers: {} }] });
    expect(merged.poses).toEqual([{ name: 'x', fingers: {} }]);
  });

  it('ignores unknown keys, wrong types and non-finite numbers', () => {
    const patch = {
      nope: 1,
      dwellMs: 'slow',
      lostAfterMs: Number.NaN,
      pinch: { closed: Number.POSITIVE_INFINITY, extra: 3, open: 0.8 },
      smoothing: 5,
      poses: 'fist',
    } as unknown as GestureCoreConfigPatch;
    const merged = mergeConfig(defaultConfig(), patch);
    const expected = defaultConfig();
    expected.pinch.open = 0.8;
    expect(merged).toEqual(expected);
  });
});
