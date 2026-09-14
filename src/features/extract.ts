import type { Features, GestureCoreConfig, Landmark } from '../types.js';
import { clamp, dist, isotropic, jointBend, LANDMARK_COUNT, LM, unlerp, type Vec3 } from './geometry.js';

export type ExtractOptions = Pick<GestureCoreConfig, 'pinch' | 'curl' | 'aspect'>;

/** Guards ratio features against a collapsed hand. Keeps every output finite. */
const MIN_SPAN = 1e-9;

/** [base, joint, tip] per finger, thumb → pinky. Curl is the bend at `joint` of base→joint→tip. */
const CURL_CHAINS: readonly (readonly [number, number, number])[] = [
  [LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP],
  [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP],
];

const PALM = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP] as const;

/** Landmark[] → Features for a single frame. Pure. */
export function extractFeatures(landmarks: readonly Landmark[], opts: ExtractOptions): Features {
  if (landmarks.length !== LANDMARK_COUNT) {
    throw new RangeError(`expected ${LANDMARK_COUNT} landmarks, got ${landmarks.length}`);
  }
  const aspect = opts.aspect > 0 ? opts.aspect : 1;
  const p: Vec3[] = landmarks.map((l) => isotropic(l, aspect));
  const at = (i: number): Vec3 => p[i]!;

  const span = dist(at(LM.WRIST), at(LM.MIDDLE_MCP));
  const ref = Math.max(span, MIN_SPAN);

  const pinchRaw = dist(at(LM.THUMB_TIP), at(LM.INDEX_TIP)) / ref;
  const pinch = unlerp(pinchRaw, opts.pinch.closed, opts.pinch.open);

  const curls = CURL_CHAINS.map(([a, b, c], finger) => {
    const bend = jointBend(at(a), at(b), at(c));
    return finger === 0
      ? unlerp(bend, opts.curl.thumbStraight, opts.curl.thumbBent)
      : unlerp(bend, opts.curl.straight, opts.curl.bent);
  });

  const openness = clamp(1 - (curls[1]! + curls[2]! + curls[3]! + curls[4]!) / 4, 0, 1);

  const w = at(LM.WRIST);
  const m = at(LM.MIDDLE_MCP);
  const tilt = span < MIN_SPAN ? 0 : Math.atan2(m.x - w.x, -(m.y - w.y));

  let cx = 0;
  let cy = 0;
  for (const i of PALM) {
    cx += landmarks[i]!.x;
    cy += landmarks[i]!.y;
  }

  return {
    pinch,
    openness,
    curls,
    tilt,
    centroid: { x: cx / PALM.length, y: cy / PALM.length },
    span,
    pinchRaw,
  };
}
