import { describe, expect, it } from 'vitest';
import { EYES } from '../src/canonical.js';
import { eulerDegrees, eyeAspect, headRotation } from '../src/pose.js';
import { fromAngles, measure, relative } from '../src/readings.js';
import { MIRROR, synthFace, type Synth } from './helpers.js';

const angles = (o: Synth, mirrored = o.mirrored ?? false) => measure(synthFace(o), { aspect: o.aspect ?? 1, mirrored }).angles;

describe('the synthetic faces mean what they say', () => {
  const nose = (o: Synth) => synthFace(o).landmarks[1]!;
  it('turning right swings the nose toward the camera’s left', () => {
    expect(nose({ yaw: 20 }).x).toBeLessThan(nose({}).x);
  });
  it('looking up raises the nose in the frame', () => {
    expect(nose({ pitch: 20 }).y).toBeLessThan(nose({}).y);
  });
  it('tilting right moves the forehead toward the camera’s left of the chin', () => {
    const f = synthFace({ roll: 20 }).landmarks;
    expect(f[10]!.x).toBeLessThan(f[152]!.x);
  });
  it('the mirror map pairs the eyes and keeps the midline', () => {
    expect(MIRROR[33]).toBe(263);
    expect(MIRROR[133]).toBe(362);
    expect(MIRROR[1]).toBe(1);
  });
});

describe('head angles', () => {
  it('the canonical face, square on, reads zero', () => {
    const a = angles({});
    expect(Math.abs(a.yaw)).toBeLessThan(1e-6);
    expect(Math.abs(a.pitch)).toBeLessThan(1e-6);
    expect(Math.abs(a.roll)).toBeLessThan(1e-6);
  });

  const grid: [number, number, number][] = [];
  for (const yaw of [-45, -20, 0, 15, 40]) for (const pitch of [-30, 0, 25]) for (const roll of [-25, 0, 10]) grid.push([yaw, pitch, roll]);

  it.each(grid)('recovers yaw %d, pitch %d, roll %d', (yaw, pitch, roll) => {
    const a = angles({ yaw, pitch, roll });
    expect(a.yaw).toBeCloseTo(yaw, 6);
    expect(a.pitch).toBeCloseTo(pitch, 6);
    expect(a.roll).toBeCloseTo(roll, 6);
  });

  it('does not care where the face is, how big, or the frame shape', () => {
    const want = { yaw: 25, pitch: -12, roll: 8 };
    for (const o of [{ aspect: 16 / 9 }, { aspect: 4 / 3, scale: 0.008 }, { at: { x: 0.2, y: 0.8 }, scale: 0.04 }]) {
      const a = angles({ ...want, ...o });
      expect(a.yaw).toBeCloseTo(want.yaw, 6);
      expect(a.pitch).toBeCloseTo(want.pitch, 6);
      expect(a.roll).toBeCloseTo(want.roll, 6);
    }
  });

  it('a wrong aspect distorts the reading (so it is required)', () => {
    const f = synthFace({ yaw: 30, roll: 10, aspect: 16 / 9 });
    const wrong = measure(f, { aspect: 1, mirrored: false }).angles;
    expect(Math.abs(wrong.yaw - 30) + Math.abs(wrong.roll - 10)).toBeGreaterThan(2);
  });

  it('an expression does not move the head: lips, jaw and brows are not anchors', () => {
    const open = { 13: [0, 0.8, 0], 14: [0, -1.5, 0.2], 152: [0, -2, -0.5], 105: [0, 1, 0], 334: [0, 1, 0], 61: [-0.4, 0.5, 0], 291: [0.4, 0.5, 0] } as const;
    const a = angles({ yaw: 10, pitch: 5, move: open as unknown as Synth['move'] });
    expect(a.yaw).toBeCloseTo(10, 6);
    expect(a.pitch).toBeCloseTo(5, 6);
    expect(a.roll).toBeCloseTo(0, 6);
  });

  it('noise of a few thousandths of the frame moves the angles by little', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
    const f = synthFace({ yaw: 20, pitch: -10, roll: 5, scale: 0.02 });
    const noisy = { landmarks: f.landmarks.map((p) => ({ x: p.x + 0.002 * rnd(), y: p.y + 0.002 * rnd(), z: p.z + 0.004 * rnd() })) };
    const a = measure(noisy, { aspect: 1, mirrored: false }).angles;
    expect(Math.abs(a.yaw - 20)).toBeLessThan(3);
    expect(Math.abs(a.pitch + 10)).toBeLessThan(3);
    expect(Math.abs(a.roll - 5)).toBeLessThan(3);
  });

  it('a mirrored frame, declared as mirrored, reads the same as the raw one', () => {
    for (const o of [{ yaw: 25, pitch: 10, roll: -12 }, { yaw: -35, pitch: -5, roll: 20 }]) {
      const raw = angles(o);
      const mirrored = angles({ ...o, mirrored: true });
      expect(mirrored.yaw).toBeCloseTo(raw.yaw, 6);
      expect(mirrored.pitch).toBeCloseTo(raw.pitch, 6);
      expect(mirrored.roll).toBeCloseTo(raw.roll, 6);
    }
  });

  it('a mirrored frame not declared as mirrored reads turn and tilt reversed', () => {
    const a = angles({ yaw: 25, roll: 10, mirrored: true }, false);
    expect(a.yaw).toBeCloseTo(-25, 6);
    expect(a.roll).toBeCloseTo(-10, 6);
  });
});

describe('rotations', () => {
  it('fromAngles and eulerDegrees are inverses', () => {
    for (const a of [{ yaw: 30, pitch: -20, roll: 15 }, { yaw: -70, pitch: 40, roll: -60 }]) {
      const back = eulerDegrees(fromAngles(a));
      expect(back.yaw).toBeCloseTo(a.yaw, 9);
      expect(back.pitch).toBeCloseTo(a.pitch, 9);
      expect(back.roll).toBeCloseTo(a.roll, 9);
    }
  });

  it('headRotation returns a proper rotation', () => {
    const R = headRotation(synthFace({ yaw: 33, pitch: -17, roll: 21 }).landmarks, 1);
    const det =
      R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
      R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
      R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    expect(det).toBeCloseTo(1, 9);
  });

  it('relative angles compose rotations: from a head held looking up, a turn is still a pure turn', () => {
    const neutral = { yaw: 0, pitch: 20, roll: 0 };
    // turn 30° about the neck while keeping the upward look
    const turned = eulerDegrees(
      (() => {
        const R = fromAngles({ yaw: 30, pitch: 0, roll: 0 });
        const N = fromAngles(neutral);
        return R.map((r) => [0, 1, 2].map((j) => r[0] * N[0]![j]! + r[1] * N[1]![j]! + r[2] * N[2]![j]!)) as typeof R;
      })(),
    );
    const rel = relative(turned, neutral);
    expect(rel.yaw).toBeCloseTo(30, 6);
    expect(rel.pitch).toBeCloseTo(0, 6);
    expect(rel.roll).toBeCloseTo(0, 6);
  });

  it('with no neutral, relative is the identity', () => {
    expect(relative({ yaw: 12, pitch: -3, roll: 4 }, { yaw: 0, pitch: 0, roll: 0 })).toEqual({ yaw: 12, pitch: -3, roll: 4 });
  });
});

describe('eyes', () => {
  it('measures the eye aspect ratio it was given, per anatomical eye', () => {
    const f = synthFace({ earLeft: 0.31, earRight: 0.09 });
    expect(eyeAspect(f.landmarks, EYES.left, 1)).toBeCloseTo(0.31, 9);
    expect(eyeAspect(f.landmarks, EYES.right, 1)).toBeCloseTo(0.09, 9);
  });

  it('a turned head barely changes it', () => {
    const f = synthFace({ yaw: 30, pitch: 10, earLeft: 0.3 });
    expect(eyeAspect(f.landmarks, EYES.left, 1)).toBeCloseTo(0.3, 6);
  });

  it('a mirrored frame, declared, keeps the eyes on the right sides', () => {
    const m = measure(synthFace({ earLeft: 0.31, earRight: 0.09, mirrored: true }), { aspect: 1, mirrored: true });
    expect(m.earLeft).toBeCloseTo(0.31, 9);
    expect(m.earRight).toBeCloseTo(0.09, 9);
  });
});
