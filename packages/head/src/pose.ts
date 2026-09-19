import type { Landmark } from 'gesturecore';
import { ANCHORS } from './canonical.js';

export type Vec3 = [number, number, number];
/** Row-major 3×3. */
export type Mat3 = [Vec3, Vec3, Vec3];

/**
 * A landmark in the canonical model's axes: +x toward image right, +y up, +z toward the
 * camera, all in the same unit. MediaPipe's `z` is on the scale of `x`, which is a
 * fraction of the frame width.
 *
 * There is no mirroring here on purpose. A face tracker labels a mirrored face as if it
 * were an ordinary one (its "left eye" is whichever eye sits on image right), so the
 * landmarks always match the canonical model; mirroring only changes what the result
 * means, and the reader handles that afterwards.
 */
export function toModelAxes(p: Landmark, aspect: number): Vec3 {
  return [p.x * aspect, -p.y, -p.z * aspect];
}

/**
 * The rotation that best carries the canonical face onto the observed one (least squares,
 * Horn 1987, "closed-form solution of absolute orientation using unit quaternions").
 * Scale and position drop out; only the turn of the head is left.
 */
export function headRotation(landmarks: readonly Landmark[], aspect: number): Mat3 {
  const model: Vec3[] = [];
  const seen: Vec3[] = [];
  for (const [i, v] of ANCHORS) {
    const p = landmarks[i];
    if (!p) continue;
    model.push([v[0], v[1], v[2]]);
    seen.push(toModelAxes(p, aspect));
  }
  const mc = centroid(model);
  const sc = centroid(seen);
  // S[a][b] = Σ model_a · seen_b, over centred points
  const S: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let k = 0; k < model.length; k++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) S[a]![b]! += (model[k]![a]! - mc[a]!) * (seen[k]![b]! - sc[b]!);
    }
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w, x, y, z] = largestEigenvector(N);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

/**
 * Yaw, pitch and roll in degrees, from the user's point of view in an unmirrored frame:
 * yaw + turns to their right, pitch + looks up, roll + tilts toward their right
 * shoulder. (In a mirrored frame yaw and roll come out reversed.) The rotation is
 * taken apart as yaw, then pitch, then roll (R = Ry · Rx · Rz), the order in which a head
 * turns on the neck.
 */
export function eulerDegrees(R: Mat3): { yaw: number; pitch: number; roll: number } {
  const deg = 180 / Math.PI;
  // The face's forward axis is R's third column. The face's own right is the camera's
  // left, so turning to the user's right swings the nose toward −x.
  const yaw = -Math.atan2(R[0][2], R[2][2]) * deg;
  const pitch = Math.asin(Math.max(-1, Math.min(1, R[1][2]))) * deg;
  // Tilting toward the right shoulder swings the top of the head toward −x as well.
  const roll = Math.atan2(R[1][0], R[1][1]) * deg;
  return { yaw: clean(yaw), pitch: clean(pitch), roll: clean(roll) };
}

/** Eye aspect ratio: lid opening over eye width, in 3D, so a turned head changes it less. */
export function eyeAspect(
  landmarks: readonly Landmark[],
  eye: { corners: readonly number[]; upper: readonly number[]; lower: readonly number[] },
  aspect: number,
): number {
  const at = (i: number) => toModelAxes(landmarks[i]!, aspect);
  const width = dist(at(eye.corners[0]!), at(eye.corners[1]!));
  if (!(width > 0)) return 0;
  const open = eye.upper.reduce((s, u, k) => s + dist(at(u), at(eye.lower[k]!)), 0) / eye.upper.length;
  return open / width;
}

function centroid(points: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) for (let a = 0; a < 3; a++) c[a]! += p[a]! / points.length;
  return c;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** −0 and float dust read as 0, so a straight face reports exactly zero. */
function clean(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : v;
}

/** Cyclic Jacobi eigen-decomposition of a symmetric 4×4; returns the unit eigenvector of the largest eigenvalue. */
function largestEigenvector(input: number[][]): [number, number, number, number] {
  const a = input.map((r) => [...r]);
  const v = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j): number => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p]![q]! ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i]![i]! > a[best]![best]!) best = i;
  const q = [0, 1, 2, 3].map((k) => v[k]![best]!);
  // q and −q are the same rotation; pick w ≥ 0 so the result is deterministic
  const sign = q[0]! < 0 ? -1 : 1;
  const n = Math.hypot(...q) || 1;
  return [(sign * q[0]!) / n, (sign * q[1]!) / n, (sign * q[2]!) / n, (sign * q[3]!) / n];
}
