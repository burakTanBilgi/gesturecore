import type { Landmark } from '../types.js';

/** MediaPipe hand landmark indices. */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export const LANDMARK_COUNT = 21;

export type Vec3 = { x: number; y: number; z: number };

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

export function dist(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/** Angle between two vectors in radians, 0..π. Returns 0 for a zero-length vector. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const la = length(a);
  const lb = length(b);
  if (la === 0 || lb === 0) return 0;
  const c = dot(a, b) / (la * lb);
  return Math.acos(clamp(c, -1, 1));
}

/**
 * Bend angle at joint `b` for the chain a → b → c, in radians.
 * 0 when the chain is straight, approaching π as it folds back on itself.
 */
export function jointBend(a: Vec3, b: Vec3, c: Vec3): number {
  return angleBetween(sub(b, a), sub(c, b));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear map of v from [a, b] onto [0, 1], clamped. Degenerate ranges become a step at a. */
export function unlerp(v: number, a: number, b: number): number {
  const d = b - a;
  if (Math.abs(d) < 1e-9) return v < a ? 0 : 1;
  return clamp((v - a) / d, 0, 1);
}

/** Scale x and z by `aspect` so all three axes share one unit (frame height). */
export function isotropic(p: Landmark, aspect: number): Vec3 {
  return { x: p.x * aspect, y: p.y, z: p.z * aspect };
}
