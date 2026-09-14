import { readFileSync } from 'node:fs';
import type { Hand, HandLabel, Landmark } from '../src/types.js';

export type FixtureName = 'open' | 'fist' | 'point' | 'pinch';

export const FIXTURE_NAMES: FixtureName[] = ['open', 'fist', 'point', 'pinch'];

export function loadFixture(name: FixtureName): Landmark[] {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Landmark[];
}

export function hand(landmarks: Landmark[], handedness: HandLabel = 'Right'): Hand {
  return { landmarks, handedness, score: 1 };
}

export function clone(landmarks: Landmark[]): Landmark[] {
  return landmarks.map((p) => ({ ...p }));
}

/** Copy of `landmarks` with every point moved by (dx, dy). */
export function translate(landmarks: Landmark[], dx: number, dy: number): Landmark[] {
  return landmarks.map((p) => ({ x: p.x + dx, y: p.y + dy, z: p.z }));
}

/** Copy of `landmarks` scaled by k about the wrist (simulates moving toward/away from camera). */
export function scale(landmarks: Landmark[], k: number): Landmark[] {
  const w = landmarks[0]!;
  return landmarks.map((p) => ({ x: w.x + (p.x - w.x) * k, y: w.y + (p.y - w.y) * k, z: p.z * k }));
}

/** Copy of `landmarks` rotated by `rad` in the image plane about the wrist. */
export function rotate(landmarks: Landmark[], rad: number): Landmark[] {
  const w = landmarks[0]!;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return landmarks.map((p) => {
    const x = p.x - w.x;
    const y = p.y - w.y;
    return { x: w.x + x * c - y * s, y: w.y + x * s + y * c, z: p.z };
  });
}

/** Copy of `landmarks` mirrored horizontally in normalised coordinates. */
export function mirror(landmarks: Landmark[]): Landmark[] {
  return landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
}

/**
 * Copy of `landmarks` with the thumb tip placed so that dist(4, 8) / span equals `ratio`
 * exactly (in the isotropic frame), keeping its original direction from the index tip.
 */
export function withPinchRaw(landmarks: Landmark[], ratio: number): Landmark[] {
  const out = clone(landmarks);
  const w = out[0]!;
  const m = out[9]!;
  const span = Math.hypot(m.x - w.x, m.y - w.y, m.z - w.z);
  const tip = out[8]!;
  const th = out[4]!;
  let dx = th.x - tip.x;
  let dy = th.y - tip.y;
  let dz = th.z - tip.z;
  let len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) {
    dx = -1;
    dy = 0;
    dz = 0;
    len = 1;
  }
  const d = (ratio * span) / len;
  out[4] = { x: tip.x + dx * d, y: tip.y + dy * d, z: tip.z + dz * d };
  return out;
}
