import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { extractFeatures } from '../src/features/extract.js';
import { bestPose, matchPoses } from '../src/poses/match.js';
import { FIXTURE_NAMES, type FixtureName, loadFixture, loadViews, mirror, rotate, scale, translate } from './helpers.js';

/**
 * A gesture has to survive being seen from somewhere else. Two kinds of check:
 *
 * 1. Every recorded view of a fixture must still be read as the same pose. Capturing
 *    those views is a camera job, so a one-view fixture simply tests one view — the
 *    test grows teeth as real captures are added in the bench.
 * 2. Metamorphic checks: move, resize or rotate a hand and the decision must not
 *    change, because the features are span-normalised and angle-based.
 */

const config = { ...defaultConfig(), aspect: 1 };
const EXPECTED: Record<FixtureName, string> = {
  open: 'openPalm',
  fist: 'fist',
  point: 'point',
  pinch: 'openPalm',
};

const poseOf = (pts: Parameters<typeof extractFeatures>[0]) =>
  bestPose(matchPoses(extractFeatures(pts, config), config.poses, config.poseFalloff), config.poses)?.name ?? null;

describe('every recorded view reads as the same pose', () => {
  for (const name of FIXTURE_NAMES) {
    const views = loadViews(name);
    it(`${name}: ${views.length} view(s) → ${EXPECTED[name]}`, () => {
      for (const v of views) {
        expect(poseOf(v.landmarks), `view "${v.view}"`).toBe(EXPECTED[name]);
      }
    });
  }
});

describe('the same hand, seen differently', () => {
  for (const name of FIXTURE_NAMES) {
    const pts = loadFixture(name);

    it(`${name} survives being moved across the frame`, () => {
      for (const [dx, dy] of [
        [0.2, 0.1],
        [-0.15, 0.2],
      ] as const) {
        expect(poseOf(translate(pts, dx, dy))).toBe(EXPECTED[name]);
      }
    });

    it(`${name} survives moving toward and away from the camera`, () => {
      for (const k of [0.5, 0.75, 1.5, 2]) {
        expect(poseOf(scale(pts, k)), `scale ${k}`).toBe(EXPECTED[name]);
      }
    });

    it(`${name} survives an in-plane rotation`, () => {
      for (const deg of [-40, -15, 15, 40]) {
        expect(poseOf(rotate(pts, (deg * Math.PI) / 180)), `${deg}°`).toBe(EXPECTED[name]);
      }
    });

    it(`${name} reads the same mirrored (the other hand doing it)`, () => {
      expect(poseOf(mirror(pts))).toBe(EXPECTED[name]);
    });
  }
});

describe('scale invariance is exact, not approximate', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: curls and pinch distances ignore hand size`, () => {
      const a = extractFeatures(loadFixture(name), config);
      const b = extractFeatures(scale(loadFixture(name), 1.8), config);
      a.curls.forEach((curl, i) => expect(b.curls[i]).toBeCloseTo(curl, 6));
      expect(b.pinchRaw).toBeCloseTo(a.pinchRaw, 6);
      expect(b.openness).toBeCloseTo(a.openness, 6);
    });
  }
});
