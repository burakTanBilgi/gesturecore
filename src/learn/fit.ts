/**
 * Learning a gesture from a demonstration.
 *
 * Nothing here trains a model. A gesture in this library is a handful of numbers, so
 * "learning" means watching someone do the thing a few times and fitting those numbers
 * with enough margin that every take would have fired — the few-shot template approach
 * ($1 / $P style), kept deterministic and inspectable.
 *
 * Pure: no clock, no camera, no storage.
 */
import { motionProgress, type MotionSample } from '../motions/detect.js';
import { FINGERS } from '../poses/match.js';
import type { FingerName, MotionAxis, MotionDescription, PoseDescription } from '../types.js';

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ── poses ────────────────────────────────────────────────────────────────────

export type PoseFitOptions = {
  /** Slack added on each side of the observed curl range. */
  margin?: number;
  /** A finger that wandered more than this while posing is not part of the shape. */
  maxSpread?: number;
};

export type PoseFit = {
  pose: PoseDescription;
  /** Fingers left unconstrained because they moved too much to be meaningful. */
  ignored: FingerName[];
  /** Observed curl range per finger, before margin. */
  observed: Record<FingerName, { lo: number; hi: number }>;
};

/**
 * Fit a pose to several readings of one hand shape.
 *
 * Feed it a whole hold — ideally the hand seen from a few angles — rather than one
 * frame: the spread across those readings is what sets the tolerance. A finger that
 * did not stay put is dropped instead of being pinned to a meaningless range, so a
 * thumbs-up does not accidentally demand a particular pinky.
 */
export function fitPose(name: string, samples: readonly { curls: readonly number[] }[], options: PoseFitOptions = {}): PoseFit {
  if (samples.length === 0) throw new Error('fitPose needs at least one sample');
  const margin = options.margin ?? 0.08;
  const maxSpread = options.maxSpread ?? 0.35;

  const fingers: PoseDescription['fingers'] = {};
  const ignored: FingerName[] = [];
  const observed = {} as PoseFit['observed'];

  FINGERS.forEach((finger, i) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of samples) {
      const curl = s.curls[i] ?? 0;
      lo = Math.min(lo, curl);
      hi = Math.max(hi, curl);
    }
    observed[finger] = { lo: round2(lo), hi: round2(hi) };
    if (hi - lo > maxSpread) {
      ignored.push(finger);
      return;
    }
    fingers[finger] = { curl: [round2(clamp01(lo - margin)), round2(clamp01(hi + margin))] };
  });

  return { pose: { name, fingers }, ignored, observed };
}

// ── movements ────────────────────────────────────────────────────────────────

/** Typical size of a deliberate movement on each axis, used to compare axes fairly. */
const AXIS_SCALE: Record<MotionAxis, number> = { x: 1.5, y: 1.5, depth: 0.25, tilt: 0.6 };
const AXES: MotionAxis[] = ['x', 'y', 'depth', 'tilt'];

export type MotionTake = readonly MotionSample[];

export type MotionFitOptions = {
  /** Require this pose to be held throughout. */
  pose?: string;
  cooldownMs?: number;
  /** Keep this share of the smallest demonstrated stroke as the threshold. */
  keep?: number;
  /** Allow this much longer than the slowest demonstration. */
  slack?: number;
};

export type MotionFit = {
  motion: MotionDescription;
  /** How each take scored against the fitted movement: 1 means it would have fired. */
  takes: number[];
  /** Per-axis median travel, in units of a typical movement on that axis. */
  axisScores: Record<MotionAxis, number>;
  /** How much bigger the chosen axis is than the runner-up; under ~1.5 the gesture is ambiguous. */
  margin: number;
};

/** The axis value of every sample, in the units `distance` is expressed in. */
function axisSeries(samples: MotionTake, axis: MotionAxis): number[] {
  const last = samples[samples.length - 1];
  if (!last) return [];
  const ref = Math.max(last.span, 1e-9);
  if (axis === 'x') return samples.map((s) => s.x / ref);
  if (axis === 'y') return samples.map((s) => s.y / ref);
  if (axis === 'depth') return samples.map((s) => Math.log(Math.max(s.span, 1e-9)));
  const out: number[] = [];
  let offset = 0;
  samples.forEach((s, i) => {
    if (i > 0) {
      const d = s.tilt - samples[i - 1]!.tilt;
      if (d > Math.PI) offset -= 2 * Math.PI;
      else if (d < -Math.PI) offset += 2 * Math.PI;
    }
    out.push(s.tilt + offset);
  });
  return out;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/**
 * The out-and-back strokes in a series: each run that travels at least `minSize`
 * before turning back by at least as much.
 *
 * A recording usually starts and ends mid-stroke, so a small first or last stroke is
 * dropped — otherwise a four-stroke wave caught inside a six-second recording would be
 * learnt as needing six.
 */
function strokes(values: number[], minSize: number): { sizes: number[]; netSign: number } {
  const netSign = Math.sign(values[values.length - 1]! - values[0]!) || 1;
  if (values.length < 2 || !(minSize > 0)) return { sizes: [], netSign };

  const sizes: number[] = [];
  let dir = 0;
  let last = values[0]!; // last confirmed turning point
  let extreme = values[0]!; // furthest point since then, in the current direction
  for (const v of values) {
    if (dir === 0) {
      if (Math.abs(v - last) >= minSize) {
        dir = Math.sign(v - last);
        extreme = v;
      }
      continue;
    }
    if (dir * (v - extreme) > 0) extreme = v;
    else if (dir * (extreme - v) >= minSize) {
      sizes.push(Math.abs(extreme - last));
      last = extreme;
      dir = -dir;
      extreme = v;
    }
  }
  if (dir !== 0 && Math.abs(extreme - last) >= minSize) sizes.push(Math.abs(extreme - last));

  if (sizes.length >= 3) {
    const typical = median(sizes);
    if (sizes[0]! < typical * 0.6) sizes.shift();
    if (sizes.length >= 3 && sizes[sizes.length - 1]! < typical * 0.6) sizes.pop();
  }
  return { sizes, netSign };
}

/**
 * Fit a movement to a few demonstrations of it.
 *
 * Picks the axis that actually carried the movement, counts how many strokes it took,
 * then sets a distance every take clears and a time every take fits inside. The result
 * is checked against the takes themselves, and loosened until they all pass, so a
 * fitted movement always fires for the demonstrations it came from.
 */
export function fitMotion(name: string, takes: readonly MotionTake[], options: MotionFitOptions = {}): MotionFit {
  const usable = takes.filter((t) => t.length >= 2);
  if (usable.length === 0) throw new Error('fitMotion needs a take with at least two samples');
  const keep = options.keep ?? 0.7;
  const slack = options.slack ?? 1.35;

  // 1. which axis carried it, judged in units of a typical movement on each axis
  const axisScores = {} as Record<MotionAxis, number>;
  for (const axis of AXES) {
    axisScores[axis] = median(
      usable.map((take) => {
        const v = axisSeries(take, axis);
        return (Math.max(...v) - Math.min(...v)) / AXIS_SCALE[axis];
      }),
    );
  }
  const ranked = [...AXES].sort((a, b) => axisScores[b] - axisScores[a]);
  const axis = ranked[0]!;
  const runnerUp = axisScores[ranked[1]!];
  const margin = runnerUp > 1e-9 ? axisScores[axis] / runnerUp : Infinity;

  // 2. strokes and direction, per take
  const perTake = usable.map((take) => {
    const v = axisSeries(take, axis);
    const span = Math.max(...v) - Math.min(...v);
    const { sizes, netSign } = strokes(v, span * 0.45);
    return { sizes, netSign, span, ms: take[take.length - 1]!.t - take[0]!.t };
  });
  const strokeCount = Math.max(1, Math.round(median(perTake.map((p) => Math.max(1, p.sizes.length)))));
  const reversals = strokeCount - 1;
  const direction: 1 | -1 = median(perTake.map((p) => p.netSign)) < 0 ? -1 : 1;

  // 3. a distance every take clears, and a time every take fits in
  const smallest = Math.min(...perTake.map((p) => (p.sizes.length ? Math.min(...p.sizes) : p.span)));
  let distance = Math.max(0.02, round2(smallest * keep));
  let withinMs = Math.max(150, Math.ceil((Math.max(...perTake.map((p) => p.ms)) * slack) / 50) * 50);

  // 4. check against the demonstrations, loosening until they all pass
  const build = (): MotionDescription => ({
    name,
    axis,
    distance,
    withinMs,
    cooldownMs: options.cooldownMs ?? 500,
    ...(reversals > 0 ? { reversals } : { direction }),
    ...(options.pose ? { pose: options.pose } : {}),
  });
  let motion = build();
  let scores = usable.map((take) => motionProgress(take, motion, -Infinity));
  for (let tries = 0; tries < 6 && scores.some((s) => s < 1); tries++) {
    distance = round2(distance * 0.85);
    withinMs = Math.ceil((withinMs * 1.2) / 50) * 50;
    motion = build();
    scores = usable.map((take) => motionProgress(take, motion, -Infinity));
  }

  return { motion, takes: scores, axisScores, margin };
}

/**
 * Whether a movement would fire anywhere inside a recording — used to check a fitted
 * movement against hands that were not performing it.
 */
export function firesWithin(motion: MotionDescription, samples: MotionTake): boolean {
  for (let end = 2; end <= samples.length; end++) {
    if (motionProgress(samples.slice(0, end), motion, -Infinity) >= 1) return true;
  }
  return false;
}
