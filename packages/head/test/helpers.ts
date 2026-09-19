import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Landmark } from 'gesturecore';
import { EYES } from '../src/canonical.js';
import type { Face } from '../src/types.js';

type V = [number, number, number];

export const CANONICAL: V[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/canonical-face.json', import.meta.url)), 'utf8'),
) as V[];

/**
 * Rotations with plain geometric meanings, built here independently of the reader's own
 * maths: the model faces +z, +y is up, and the camera sees +x on image right.
 */
const rotY = (a: number): V[] => [
  [Math.cos(a), 0, Math.sin(a)],
  [0, 1, 0],
  [-Math.sin(a), 0, Math.cos(a)],
];
const rotX = (a: number): V[] => [
  [1, 0, 0],
  [0, Math.cos(a), -Math.sin(a)],
  [0, Math.sin(a), Math.cos(a)],
];
const rotZ = (a: number): V[] => [
  [Math.cos(a), -Math.sin(a), 0],
  [Math.sin(a), Math.cos(a), 0],
  [0, 0, 1],
];
const mul = (A: V[], B: V[]): V[] =>
  A.map((r) => [0, 1, 2].map((j) => r[0] * B[0]![j]! + r[1] * B[1]![j]! + r[2] * B[2]![j]!) as V);
const apply = (R: V[], p: V): V => R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2]) as V;

export type Synth = {
  /** Degrees. + = the user turns to their right: the nose swings toward the camera's left. */
  yaw?: number;
  /** + = looking up: the nose rises. */
  pitch?: number;
  /** + = head tilted toward the user's right shoulder: its top swings toward the camera's left. */
  roll?: number;
  /** Eye aspect ratio of each anatomical eye. Default 0.3 (open). */
  earLeft?: number;
  earRight?: number;
  aspect?: number;
  /** Frame-height units per model centimetre. */
  scale?: number;
  /** Where the face sits in the frame. */
  at?: { x: number; y: number };
  /** Produce what a tracker reports for a mirrored (selfie) frame. */
  mirrored?: boolean;
  blendshapes?: Record<string, number>;
  /** Extra per-landmark offsets in model units, applied before turning. */
  move?: Record<number, V>;
};

/** A face with exactly known angles and eyes, as a tracker would report its landmarks. */
export function synthFace(o: Synth = {}): Face {
  const rad = Math.PI / 180;
  const aspect = o.aspect ?? 1;
  const scale = o.scale ?? 0.02;
  const at = o.at ?? { x: 0.5, y: 0.5 };
  const pts: V[] = CANONICAL.map((p) => [...p] as V);
  openEye(pts, EYES.left, o.earLeft ?? 0.3);
  openEye(pts, EYES.right, o.earRight ?? 0.3);
  for (const [i, d] of Object.entries(o.move ?? {})) {
    const p = pts[Number(i)]!;
    pts[Number(i)] = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  }
  // yaw about the neck, then pitch, then roll
  const R = mul(mul(rotY(-(o.yaw ?? 0) * rad), rotX(-(o.pitch ?? 0) * rad)), rotZ((o.roll ?? 0) * rad));
  let landmarks: Landmark[] = pts.map((p) => {
    const [X, Y, Z] = apply(R, p);
    return { x: at.x + (scale * X) / aspect, y: at.y - scale * Y, z: (-scale * Z) / aspect };
  });
  if (o.mirrored) {
    // The frame is flipped, and the tracker labels the flipped face as an ordinary one:
    // the point it calls i is where the mirror partner of i now appears.
    const flipped = landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
    landmarks = flipped.map((_, i) => flipped[MIRROR[i]!]!);
  }
  return o.blendshapes ? { landmarks, blendshapes: o.blendshapes } : { landmarks };
}

/** For each vertex, the index of its mirror image across the face's midline. */
export const MIRROR: number[] = CANONICAL.map((p) => {
  let best = 0;
  let bestD = Infinity;
  CANONICAL.forEach((q, j) => {
    const d = Math.hypot(p[0] + q[0], p[1] - q[1], p[2] - q[2]);
    if (d < bestD) [best, bestD] = [j, d];
  });
  return best;
});

/** Rebuild an eye's six points so its aspect ratio is exactly `ear`. */
function openEye(pts: V[], eye: { corners: readonly number[]; upper: readonly number[]; lower: readonly number[] }, ear: number): void {
  const a = pts[eye.corners[0]!]!;
  const b = pts[eye.corners[1]!]!;
  const width = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const midY = (a[1] + b[1]) / 2;
  eye.upper.forEach((u, k) => {
    const up = pts[u]!;
    const lo = pts[eye.lower[k]!]!;
    const z = (up[2] + lo[2]) / 2;
    pts[u] = [up[0], midY + (ear * width) / 2, z];
    pts[eye.lower[k]!] = [lo[0], midY - (ear * width) / 2, z];
  });
}

/** Frames at 30 fps: `count` of them from `from` ms, each made by `make(i, t)`. */
export function frames(count: number, from: number, make: (i: number, t: number) => Face | null): { t: number; face: Face | null }[] {
  return Array.from({ length: count }, (_, i) => {
    const t = from + (i * 1000) / 30;
    return { t, face: make(i, t) };
  });
}
