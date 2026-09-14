import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  clamp,
  dist,
  isotropic,
  jointBend,
  LANDMARK_COUNT,
  LM,
  unlerp,
} from '../src/features/geometry.js';
import { FIXTURE_NAMES, loadFixture } from './helpers.js';

const o = { x: 0, y: 0, z: 0 };

describe('geometry', () => {
  it('dist is euclidean in 3D', () => {
    expect(dist(o, { x: 3, y: 4, z: 0 })).toBe(5);
    expect(dist({ x: 1, y: 2, z: 2 }, o)).toBe(3);
  });

  it('angleBetween covers 0, π/2 and π', () => {
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 })).toBe(0);
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 5, z: 0 })).toBeCloseTo(Math.PI / 2, 12);
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 })).toBeCloseTo(Math.PI, 12);
  });

  it('angleBetween is 0 for a zero-length vector instead of NaN', () => {
    expect(angleBetween(o, { x: 1, y: 0, z: 0 })).toBe(0);
  });

  it('angleBetween survives floating-point cosines just outside [-1, 1]', () => {
    const a = { x: 0.1, y: 0.2, z: 0.3 };
    const b = { x: 0.1 * 3, y: 0.2 * 3, z: 0.3 * 3 };
    expect(Number.isNaN(angleBetween(a, b))).toBe(false);
  });

  it('jointBend is 0 for a straight chain and grows as it folds', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: -1, z: 0 };
    expect(jointBend(a, b, { x: 0, y: -2, z: 0 })).toBe(0);
    expect(jointBend(a, b, { x: 1, y: -1, z: 0 })).toBeCloseTo(Math.PI / 2, 12);
    expect(jointBend(a, b, { x: 0, y: -0.5, z: 0 })).toBeCloseTo(Math.PI, 12);
  });

  it('clamp and unlerp', () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(unlerp(0.45, 0.15, 0.75)).toBeCloseTo(0.5, 12);
    expect(unlerp(0, 0.15, 0.75)).toBe(0);
    expect(unlerp(9, 0.15, 0.75)).toBe(1);
  });

  it('unlerp with a degenerate range is a step, not NaN', () => {
    expect(unlerp(0.1, 0.5, 0.5)).toBe(0);
    expect(unlerp(0.6, 0.5, 0.5)).toBe(1);
  });

  it('isotropic scales x and z by aspect, leaves y', () => {
    expect(isotropic({ x: 0.5, y: 0.5, z: 0.1 }, 16 / 9)).toEqual({ x: 0.5 * (16 / 9), y: 0.5, z: 0.1 * (16 / 9) });
  });

  it('landmark index table matches MediaPipe', () => {
    expect(LM.WRIST).toBe(0);
    expect([LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP]).toEqual([4, 8, 12, 16, 20]);
    expect([LM.THUMB_CMC, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP]).toEqual([1, 5, 9, 13, 17]);
    expect([LM.THUMB_MCP, LM.INDEX_PIP, LM.MIDDLE_PIP, LM.RING_PIP, LM.PINKY_PIP]).toEqual([2, 6, 10, 14, 18]);
  });
});

describe('fixtures', () => {
  it.each(FIXTURE_NAMES)('%s has 21 finite points', (name) => {
    const pts = loadFixture(name);
    expect(pts).toHaveLength(LANDMARK_COUNT);
    for (const p of pts) {
      expect(Object.keys(p).sort()).toEqual(['x', 'y', 'z']);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
    }
  });

  it.each(FIXTURE_NAMES)('%s has a plausible, non-degenerate span', (name) => {
    const pts = loadFixture(name);
    const span = dist(pts[LM.WRIST]!, pts[LM.MIDDLE_MCP]!);
    expect(span).toBeGreaterThan(0.02);
    expect(span).toBeLessThan(1);
  });
});
