import { clamp } from '../features/geometry.js';
import type { Features, FingerName, PoseDescription, PoseMatch } from '../types.js';

export const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const DEFAULT_MIN_SCORE = 0.8;

/**
 * How well one curl value fits an inclusive [min, max] range.
 * 1 inside the range, falling linearly to 0 at `falloff` outside it.
 */
export function fingerFit(curl: number, range: readonly [number, number], falloff: number): number {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const d = curl < lo ? lo - curl : curl > hi ? curl - hi : 0;
  if (d === 0) return 1;
  if (!(falloff > 0)) return 0;
  return clamp(1 - d / falloff, 0, 1);
}

/** Mean of per-finger fits over the fingers the pose constrains. A pose with no constraints scores 0. */
export function scorePose(features: Pick<Features, 'curls'>, pose: PoseDescription, falloff: number): number {
  let sum = 0;
  let n = 0;
  FINGERS.forEach((finger, i) => {
    const range = pose.fingers[finger]?.curl;
    if (!range) return;
    sum += fingerFit(features.curls[i] ?? 0, range, falloff);
    n++;
  });
  return n === 0 ? 0 : sum / n;
}

/** Scores every pose, in the order given. Pure. */
export function matchPoses(
  features: Pick<Features, 'curls'>,
  poses: readonly PoseDescription[],
  falloff: number,
): PoseMatch[] {
  return poses.map((pose) => ({ name: pose.name, score: scorePose(features, pose, falloff) }));
}

/**
 * The highest-scoring pose that reaches its own minScore, or null.
 * Ties go to the pose listed first. `matches` must be in the same order as `poses`.
 */
export function bestPose(matches: readonly PoseMatch[], poses: readonly PoseDescription[]): PoseMatch | null {
  let best: PoseMatch | null = null;
  matches.forEach((m, i) => {
    const min = poses[i]?.minScore ?? DEFAULT_MIN_SCORE;
    if (m.score >= min && (best === null || m.score > best.score)) best = m;
  });
  return best;
}
