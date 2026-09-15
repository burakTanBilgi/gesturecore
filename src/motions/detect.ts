import type { MotionDescription } from '../types.js';

/** One frame of what motions care about. `x`/`y` are aspect-corrected palm-centre coordinates. */
export type MotionSample = { t: number; x: number; y: number; span: number; tilt: number; pose: string | null };

const MIN_SPAN = 1e-9;

/** The axis value of every sample, in units where `distance` applies directly. */
function series(samples: readonly MotionSample[], m: MotionDescription): number[] {
  const last = samples[samples.length - 1];
  if (!last) return [];
  const ref = Math.max(last.span, MIN_SPAN);
  switch (m.axis) {
    case 'x':
      return samples.map((s) => s.x / ref);
    case 'y':
      return samples.map((s) => s.y / ref);
    case 'depth': {
      // relative size change: log ratio, so `distance` 0.25 means "25 % larger than where the stroke began"
      return samples.map((s) => Math.log(Math.max(s.span, MIN_SPAN)));
    }
    case 'tilt': {
      // unwrap so a rotation through ±π is continuous
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
    default:
      return []; // unknown axis from hand-edited JSON: never matches
  }
}

function threshold(m: MotionDescription): number {
  const d = Math.max(0, m.distance);
  return m.axis === 'depth' ? Math.log(1 + d) : d;
}

/**
 * How close the recent movement is to satisfying `m`, 0..1 (1 = fire). Pure.
 *
 * `samples` must be in time order and end at the current frame. Only samples at or after
 * `since` and inside `withinMs` of the last sample count; if `m.pose` is set, only the
 * unbroken run of samples holding that pose at the end counts.
 */
export function motionProgress(samples: readonly MotionSample[], m: MotionDescription, since: number): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const from = Math.max(since, last.t - Math.max(0, m.withinMs));
  let start = samples.length - 1;
  while (start > 0) {
    const prev = samples[start - 1]!;
    if (prev.t < from) break;
    if (m.pose !== undefined && m.pose !== '' && prev.pose !== m.pose) break;
    start--;
  }
  if (m.pose !== undefined && m.pose !== '' && last.pose !== m.pose) return 0;
  const recent = samples.slice(start);
  const v = series(recent, m);
  const thr = threshold(m);
  // `reach` tolerates floating-point rounding so travel of exactly `distance` counts.
  const reach = thr * (1 - 1e-9);
  if (v.length < 2) return 0;
  if (!(thr > 0)) return 1;

  const reversals = Math.max(0, Math.floor(m.reversals ?? 0));
  if (reversals === 0) {
    const dir = m.direction === -1 ? -1 : 1;
    const end = v[v.length - 1]! * dir;
    let lowest = Infinity;
    for (const x of v) lowest = Math.min(lowest, x * dir);
    const travel = end - lowest;
    return travel >= reach ? 1 : Math.max(0, travel / thr);
  }

  // Zig-zag: count strokes of at least `thr`, each reversing the previous one.
  const strokesNeeded = reversals + 1;
  let strokes = 0;
  let dir = 0;
  let lo = v[0]!;
  let hi = v[0]!;
  let extreme = v[0]!;
  let partial = 0;
  for (const x of v) {
    if (dir === 0) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
      if (x - lo >= reach) {
        dir = 1;
        strokes = 1;
        extreme = x;
      } else if (hi - x >= reach) {
        dir = -1;
        strokes = 1;
        extreme = x;
      } else {
        partial = Math.max(x - lo, hi - x) / thr;
      }
      continue;
    }
    if (dir * (x - extreme) >= 0) {
      extreme = x;
      partial = 0;
    } else if (dir * (extreme - x) >= reach) {
      dir = -dir;
      strokes++;
      extreme = x;
      partial = 0;
    } else {
      partial = (dir * (extreme - x)) / thr;
    }
    if (strokes >= strokesNeeded) return 1;
  }
  return Math.min(1, Math.max(0, (Math.min(strokes, strokesNeeded) + Math.min(partial, 0.99)) / strokesNeeded));
}
