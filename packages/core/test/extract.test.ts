import { describe, expect, it } from 'vitest';
import { defaultConfig, mergeConfig } from '../src/config.js';
import { extractFeatures } from '../src/features/extract.js';
import type { Features, Landmark } from '../src/types.js';
import { FIXTURE_NAMES, loadFixture, mirror, rotate, scale, translate, withPinchRaw } from './helpers.js';

const opts = defaultConfig();
const f = (pts: Landmark[], o = opts): Features => extractFeatures(pts, o);

const open = loadFixture('open');
const fist = loadFixture('fist');
const point = loadFixture('point');
const pinch = loadFixture('pinch');

/** Features that must not change when the hand moves, scales or rotates in the image plane. */
function invariant(x: Features) {
  return { pinch: x.pinch, pinchRaws: Object.values(x.pinchRaws), openness: x.openness, curls: x.curls };
}

function expectClose(a: object, b: object, digits = 9) {
  const fa = Object.values(a).flat();
  const fb = Object.values(b).flat();
  expect(fa.length).toBe(fb.length);
  fa.forEach((v, i) => expect(v as number).toBeCloseTo(fb[i] as number, digits));
}

describe('extractFeatures: shape and contract', () => {
  it('returns exactly the public feature keys', () => {
    expect(Object.keys(f(open)).sort()).toEqual(
      ['centroid', 'curls', 'openness', 'pinch', 'pinchRaw', 'pinchRaws', 'span', 'tilt'].sort(),
    );
    expect(f(open).curls).toHaveLength(5);
    expect(Object.keys(f(open).pinchRaws)).toEqual(['index', 'middle', 'ring', 'pinky']);
  });

  it('pinchRaws measures the thumb tip against every fingertip; index equals pinchRaw', () => {
    for (const finger of ['index', 'middle', 'ring', 'pinky'] as const) {
      const x = f(withPinchRaw(open, 0.123, finger));
      expect(x.pinchRaws[finger]).toBeCloseTo(0.123, 9);
      expect(x.pinchRaws.index).toBe(x.pinchRaw);
    }
  });

  it.each(FIXTURE_NAMES)('%s: every value is finite and in range', (name) => {
    const x = f(loadFixture(name));
    for (const v of [x.pinch, x.openness, ...x.curls]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(x.tilt) && Math.abs(x.tilt) <= Math.PI).toBe(true);
    expect(Number.isFinite(x.span) && x.span > 0).toBe(true);
    expect(Number.isFinite(x.pinchRaw) && x.pinchRaw >= 0).toBe(true);
  });

  it('throws on the wrong landmark count', () => {
    expect(() => f(open.slice(0, 20))).toThrow(RangeError);
    expect(() => f([...open, open[0]!])).toThrow(RangeError);
  });

  it('is pure: does not mutate its input and repeats exactly', () => {
    const before = JSON.stringify(open);
    const a = f(open);
    const b = f(open);
    expect(JSON.stringify(open)).toBe(before);
    expect(a).toEqual(b);
  });

  it('stays finite for a fully collapsed hand', () => {
    const collapsed = open.map(() => ({ x: 0.5, y: 0.5, z: 0 }));
    const x = f(collapsed);
    for (const v of [x.pinch, x.openness, x.tilt, x.span, x.pinchRaw, ...x.curls, x.centroid.x, x.centroid.y]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('extractFeatures: fixtures', () => {
  it('open palm: fingers straight, pinch open', () => {
    const x = f(open);
    expect(x.openness).toBeGreaterThan(0.85);
    for (const c of x.curls.slice(1)) expect(c).toBeLessThan(0.15);
    expect(x.pinch).toBeGreaterThan(0.9);
  });

  it('fist: four fingers curled, openness near zero', () => {
    const x = f(fist);
    expect(x.openness).toBeLessThan(0.2);
    for (const c of x.curls.slice(1)) expect(c).toBeGreaterThan(0.75);
  });

  it('point: index straight, the rest curled', () => {
    const x = f(point);
    expect(x.curls[1]).toBeLessThan(0.2);
    for (const c of x.curls.slice(2)) expect(c).toBeGreaterThan(0.75);
    expect(x.openness).toBeGreaterThan(0.15);
    expect(x.openness).toBeLessThan(0.4);
  });

  it('pinch: thumb and index tips together', () => {
    const x = f(pinch);
    expect(x.pinchRaw).toBeLessThan(opts.pinch.closed + opts.pinch.hysteresis);
    expect(x.pinch).toBeLessThan(0.1);
  });

  it('orders the four fixtures by openness: fist < point < pinch < open', () => {
    const o = [fist, point, pinch, open].map((p) => f(p).openness);
    expect([...o].sort((a, b) => a - b)).toEqual(o);
  });

  it('upright fixtures have tilt near zero', () => {
    for (const name of FIXTURE_NAMES) expect(Math.abs(f(loadFixture(name)).tilt)).toBeLessThan(0.1);
  });
});

describe('extractFeatures: pinch', () => {
  it('pinchRaw is thumb-tip to index-tip distance over span', () => {
    for (const r of [0, 0.1, 0.2, 0.45, 1.3]) {
      expect(f(withPinchRaw(open, r)).pinchRaw).toBeCloseTo(r, 9);
    }
  });

  it('normalises between closed and open and clamps to 0..1', () => {
    const { closed, open: o } = opts.pinch;
    expect(f(withPinchRaw(open, closed)).pinch).toBeCloseTo(0, 9);
    expect(f(withPinchRaw(open, o)).pinch).toBeCloseTo(1, 9);
    expect(f(withPinchRaw(open, (closed + o) / 2)).pinch).toBeCloseTo(0.5, 9);
    expect(f(withPinchRaw(open, 0.01)).pinch).toBe(0);
    expect(f(withPinchRaw(open, 3)).pinch).toBe(1);
  });

  it('respects calibrated bounds from config', () => {
    const custom = mergeConfig(opts, { pinch: { closed: 0.3, open: 0.5 } });
    expect(f(withPinchRaw(open, 0.4), custom).pinch).toBeCloseTo(0.5, 9);
  });
});

describe('extractFeatures: invariance', () => {
  it.each(FIXTURE_NAMES)('%s: scale-invariant (hand nearer or farther from camera)', (name) => {
    const pts = loadFixture(name);
    const base = f(pts);
    for (const k of [0.4, 0.7, 1.6]) {
      const x = f(scale(pts, k));
      expectClose(invariant(x), invariant(base));
      expect(x.span).toBeCloseTo(base.span * k, 9);
    }
  });

  it.each(FIXTURE_NAMES)('%s: translation-invariant', (name) => {
    const pts = loadFixture(name);
    const base = f(pts);
    const x = f(translate(pts, -0.2, 0.13));
    expectClose(invariant(x), invariant(base));
    expect(x.span).toBeCloseTo(base.span, 9);
    expect(x.tilt).toBeCloseTo(base.tilt, 9);
    expect(x.centroid.x).toBeCloseTo(base.centroid.x - 0.2, 9);
    expect(x.centroid.y).toBeCloseTo(base.centroid.y + 0.13, 9);
  });

  it.each(FIXTURE_NAMES)('%s: in-plane rotation changes tilt only', (name) => {
    const pts = loadFixture(name);
    const base = f(pts);
    for (const r of [-1.2, 0.4, 2.5]) {
      const x = f(rotate(pts, r));
      expectClose(invariant(x), invariant(base));
      expect(x.span).toBeCloseTo(base.span, 9);
      expect(Math.atan2(Math.sin(x.tilt - base.tilt - r), Math.cos(x.tilt - base.tilt - r))).toBeCloseTo(0, 9);
    }
  });

  it.each(FIXTURE_NAMES)('%s: mirroring negates tilt and flips centroid x, nothing else', (name) => {
    const pts = rotate(loadFixture(name), 0.3);
    const base = f(pts);
    const x = f(mirror(pts));
    expectClose(invariant(x), invariant(base));
    expect(x.tilt).toBeCloseTo(-base.tilt, 9);
    expect(x.centroid.x).toBeCloseTo(1 - base.centroid.x, 9);
  });

  it('tilt: 0 up, +π/2 toward +x, -π/2 toward -x', () => {
    expect(f(rotate(open, Math.PI / 2)).tilt - f(open).tilt).toBeCloseTo(Math.PI / 2, 9);
    expect(f(rotate(open, -Math.PI / 2)).tilt - f(open).tilt).toBeCloseTo(-Math.PI / 2, 9);
  });

  it.each(FIXTURE_NAMES)('%s: aspect correction recovers isotropic features from a 16:9 frame', (name) => {
    const pts = loadFixture(name);
    const aspect = 16 / 9;
    const squashed = pts.map((p) => ({ x: p.x / aspect, y: p.y, z: p.z / aspect }));
    const base = f(pts);
    const x = f(squashed, mergeConfig(opts, { aspect }));
    expectClose(invariant(x), invariant(base));
    expect(x.span).toBeCloseTo(base.span, 9);
    expect(x.tilt).toBeCloseTo(base.tilt, 9);
    // centroid is reported in the caller's own coordinates
    expect(x.centroid.x).toBeCloseTo(base.centroid.x / aspect, 9);
  });

  it('ignoring aspect on a 16:9 frame distorts pinch (documents why aspect exists)', () => {
    const aspect = 16 / 9;
    const squashed = rotate(pinch, Math.PI / 2).map((p) => ({ x: p.x / aspect, y: p.y, z: p.z / aspect }));
    const wrong = f(squashed).pinchRaw;
    const right = f(squashed, mergeConfig(opts, { aspect })).pinchRaw;
    expect(Math.abs(wrong - right) / right).toBeGreaterThan(0.05);
  });
});

describe('extractFeatures: curl mapping', () => {
  it('a straight finger is 0, a finger folded to the bent angle is 1', () => {
    const pts = open.map((p) => ({ ...p }));
    // Index: MCP (5) at origin, PIP (6) straight up, tip (8) folded back by exactly `bent` radians.
    const mcp = pts[5]!;
    const pip = { x: mcp.x, y: mcp.y - 0.05, z: mcp.z };
    pts[6] = pip;
    const a = opts.curl.bent;
    pts[8] = { x: pip.x + Math.sin(a) * 0.05, y: pip.y - Math.cos(a) * 0.05, z: mcp.z };
    expect(f(pts).curls[1]).toBeCloseTo(1, 9);
    pts[8] = { x: pip.x, y: pip.y - 0.05, z: mcp.z };
    expect(f(pts).curls[1]).toBe(0);
  });

  it('uses joint 3 for the thumb', () => {
    const pts = open.map((p) => ({ ...p }));
    const before = f(pts).curls[0];
    pts[7] = { x: 0, y: 0, z: 0 }; // index DIP: irrelevant to every curl
    expect(f(pts).curls[0]).toBe(before);
    const ip = pts[3]!;
    const mcp = pts[2]!;
    // fold the thumb tip back past thumbBent
    pts[4] = { x: ip.x - (ip.x - mcp.x), y: ip.y - (ip.y - mcp.y), z: ip.z };
    expect(f(pts).curls[0]).toBe(1);
  });
});
