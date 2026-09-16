import { readFileSync } from 'node:fs';
import type { Hand, HandLabel, Landmark } from '../src/types.js';

export type FixtureName = 'open' | 'fist' | 'point' | 'pinch';

export const FIXTURE_NAMES: FixtureName[] = ['open', 'fist', 'point', 'pinch'];

/** One hand shape seen from one angle or distance. */
export type FixtureView = { view: string; landmarks: Landmark[] };

/**
 * A fixture is either a bare 21-point array (the original one-view format) or a set
 * of views of the same shape. Recognition has to survive every view, which is where
 * landmark trackers are weakest.
 */
type FixtureFile = Landmark[] | { name?: string; hand?: HandLabel; views: FixtureView[] };

function read(name: FixtureName): FixtureFile {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as FixtureFile;
}

/** Every view of a fixture; a one-view file reads as a single "front" view. */
export function loadViews(name: FixtureName): FixtureView[] {
  const file = read(name);
  return Array.isArray(file) ? [{ view: 'front', landmarks: file }] : file.views;
}

/** The reference view — the front one when present, else the first. */
export function loadFixture(name: FixtureName): Landmark[] {
  const views = loadViews(name);
  return (views.find((v) => v.view === 'front') ?? views[0]!).landmarks;
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

const TIPS = { index: 8, middle: 12, ring: 16, pinky: 20 } as const;
export type TipName = keyof typeof TIPS;

function spanOf(pts: Landmark[]): number {
  const w = pts[0]!;
  const m = pts[9]!;
  return Math.hypot(m.x - w.x, m.y - w.y, m.z - w.z);
}

/**
 * Copy of `landmarks` with fingertips moved so thumb-tip ↔ fingertip / span equals the given
 * ratio exactly, each along its original direction from the (unchanged) thumb tip.
 */
export function withThumbDistances(landmarks: Landmark[], ratios: Partial<Record<TipName, number>>): Landmark[] {
  const out = clone(landmarks);
  const span = spanOf(out);
  const th = out[4]!;
  for (const [name, ratio] of Object.entries(ratios) as [TipName, number][]) {
    const tip = out[TIPS[name]]!;
    const d = [tip.x - th.x, tip.y - th.y, tip.z - th.z];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    const k = (ratio * span) / len;
    out[TIPS[name]] = { x: th.x + d[0]! * k, y: th.y + d[1]! * k, z: th.z + d[2]! * k };
  }
  return out;
}

/**
 * Copy of `landmarks` with the thumb tip placed so that dist(thumb tip, finger tip) / span equals
 * `ratio` exactly (in the isotropic frame), keeping its original direction from that fingertip.
 */
export function withPinchRaw(landmarks: Landmark[], ratio: number, finger: TipName = 'index'): Landmark[] {
  const out = clone(landmarks);
  const span = spanOf(out);
  const tip = out[TIPS[finger]]!;
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
