import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { extractFeatures } from '../src/features/extract.js';
import { DEFAULT_POSES, FIST, OPEN_PALM, POINT } from '../src/poses/defaults.js';
import { bestPose, fingerFit, matchPoses, scorePose } from '../src/poses/match.js';
import type { PoseDescription } from '../src/types.js';
import { type FixtureName, loadFixture } from './helpers.js';

const config = defaultConfig();
const falloff = config.poseFalloff;
const features = (name: FixtureName) => extractFeatures(loadFixture(name), config);
const score = (name: FixtureName, pose: PoseDescription) => scorePose(features(name), pose, falloff);
const curls = (...c: number[]) => ({ curls: c });

describe('fingerFit', () => {
  it('is 1 anywhere inside the inclusive range', () => {
    for (const c of [0.75, 0.8, 1]) expect(fingerFit(c, [0.75, 1], 0.15)).toBe(1);
  });

  it('falls linearly to 0 over `falloff` outside the range', () => {
    expect(fingerFit(0.675, [0.75, 1], 0.15)).toBeCloseTo(0.5, 12);
    expect(fingerFit(0.6, [0.75, 1], 0.15)).toBeCloseTo(0, 12);
    expect(fingerFit(0.1, [0.75, 1], 0.15)).toBe(0);
    expect(fingerFit(0.4, [0, 0.25], 0.3)).toBeCloseTo(0.5, 12);
  });

  it('tolerates reversed ranges and a zero falloff', () => {
    expect(fingerFit(0.8, [1, 0.75], 0.15)).toBe(1);
    expect(fingerFit(0.74, [0.75, 1], 0)).toBe(0);
    expect(fingerFit(0.75, [0.75, 1], 0)).toBe(1);
  });
});

describe('scorePose', () => {
  it('is the mean of per-finger fits over constrained fingers only', () => {
    const pose: PoseDescription = { name: 'p', fingers: { index: { curl: [0, 0.2] }, ring: { curl: [0.8, 1] } } };
    // thumb/middle/pinky are wildly off but unconstrained; index fits (1), ring is 0.075 short (0.5)
    expect(scorePose(curls(1, 0.1, 1, 0.725, 0), pose, 0.15)).toBeCloseTo(0.75, 12);
  });

  it('supports the thumb', () => {
    const pose: PoseDescription = { name: 'thumbsUp', fingers: { thumb: { curl: [0, 0.2] } } };
    expect(scorePose(curls(0.1, 1, 1, 1, 1), pose, 0.15)).toBe(1);
    expect(scorePose(curls(0.9, 1, 1, 1, 1), pose, 0.15)).toBe(0);
  });

  it('scores 0 for a pose with no constraints', () => {
    expect(scorePose(curls(0, 0, 0, 0, 0), { name: 'empty', fingers: {} }, 0.15)).toBe(0);
    expect(scorePose(curls(0, 0, 0, 0, 0), { name: 'noCurl', fingers: { index: {} } }, 0.15)).toBe(0);
  });
});

describe('default poses against fixtures', () => {
  it('fist scores >0.9 on fist and <0.3 on openPalm', () => {
    expect(score('fist', FIST)).toBeGreaterThan(0.9);
    expect(score('fist', OPEN_PALM)).toBeLessThan(0.3);
  });

  it('open scores >0.9 on openPalm and <0.3 on fist', () => {
    expect(score('open', OPEN_PALM)).toBeGreaterThan(0.9);
    expect(score('open', FIST)).toBeLessThan(0.3);
  });

  it('point scores >0.9 on point and below minScore on fist and openPalm', () => {
    expect(score('point', POINT)).toBeGreaterThan(0.9);
    expect(score('point', FIST)).toBeLessThan(0.8);
    expect(score('point', OPEN_PALM)).toBeLessThan(0.8);
  });

  it('open is not mistaken for point, nor fist for point', () => {
    expect(score('open', POINT)).toBeLessThan(0.8);
    expect(score('fist', POINT)).toBeLessThan(0.8);
  });

  it.each([
    ['fist', 'fist'],
    ['open', 'openPalm'],
    ['point', 'point'],
  ] as const)('bestPose(%s) is %s', (fixture, pose) => {
    const m = matchPoses(features(fixture), DEFAULT_POSES, falloff);
    expect(bestPose(m, DEFAULT_POSES)?.name).toBe(pose);
  });

  it('a pinch is not reported as fist or point', () => {
    const m = matchPoses(features('pinch'), DEFAULT_POSES, falloff);
    expect(['fist', 'point']).not.toContain(bestPose(m, DEFAULT_POSES)?.name);
  });
});

describe('matchPoses and bestPose', () => {
  it('returns one score per pose, in config order', () => {
    const m = matchPoses(features('fist'), DEFAULT_POSES, falloff);
    expect(m.map((x) => x.name)).toEqual(['fist', 'openPalm', 'point']);
  });

  it('respects per-pose minScore, defaulting to 0.8', () => {
    const poses: PoseDescription[] = [
      { name: 'strict', fingers: { index: { curl: [0, 0.1] } }, minScore: 0.95 },
      { name: 'loose', fingers: { index: { curl: [0, 0.1] } } },
    ];
    const m = [
      { name: 'strict', score: 0.9 },
      { name: 'loose', score: 0.9 },
    ];
    expect(bestPose(m, poses)?.name).toBe('loose');
    expect(bestPose([{ name: 'loose', score: 0.79 }], [poses[1]!])).toBeNull();
    expect(bestPose([{ name: 'loose', score: 0.8 }], [poses[1]!])?.name).toBe('loose');
  });

  it('breaks ties in favour of the pose listed first', () => {
    const poses: PoseDescription[] = [
      { name: 'a', fingers: {} },
      { name: 'b', fingers: {} },
    ];
    expect(bestPose([{ name: 'a', score: 1 }, { name: 'b', score: 1 }], poses)?.name).toBe('a');
  });

  it('returns null when nothing qualifies or there are no poses', () => {
    expect(bestPose([], [])).toBeNull();
  });
});
