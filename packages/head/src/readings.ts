import { EYES, HIGHEST_INDEX } from './canonical.js';
import { eulerDegrees, eyeAspect, headRotation, type Mat3 } from './pose.js';
import type { Face, HeadReaderConfig, Neutral, Readings } from './types.js';

export type Angles = { yaw: number; pitch: number; roll: number };

/** Everything measured from one face, before smoothing and before the neutral is applied. */
export type Measured = {
  /** Head angles against the canonical face, degrees, from the user's point of view. */
  angles: Angles;
  /** Eye aspect ratio of each anatomical eye. */
  earLeft: number;
  earRight: number;
  /** Channels derived from blendshapes, plus the raw blendshapes, when the face had any. */
  channels: Record<string, number>;
};

/** True when a face has every landmark the reader uses, all finite. */
export function usable(face: Face | null | undefined): face is Face {
  if (!face || !Array.isArray(face.landmarks) || face.landmarks.length <= HIGHEST_INDEX) return false;
  return face.landmarks.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z));
}

/** Measures one face. Pure. */
export function measure(face: Face, config: Pick<HeadReaderConfig, 'aspect' | 'mirrored'>): Measured {
  const raw = eulerDegrees(headRotation(face.landmarks, config.aspect));
  // A tracker reads a mirrored face as an ordinary one: the turn and the tilt come out
  // reversed, and the eye it calls left is the user's right.
  const flip = config.mirrored ? -1 : 1;
  const angles = { yaw: flip * raw.yaw, pitch: raw.pitch, roll: flip * raw.roll };
  const earModelLeft = eyeAspect(face.landmarks, EYES.left, config.aspect);
  const earModelRight = eyeAspect(face.landmarks, EYES.right, config.aspect);
  return {
    angles,
    earLeft: config.mirrored ? earModelRight : earModelLeft,
    earRight: config.mirrored ? earModelLeft : earModelRight,
    channels: channels(face.blendshapes),
  };
}

/**
 * The named levels an expression can use. The derived ones average left and right, so
 * they do not depend on which side a tracker calls left.
 */
export function channels(blendshapes: Face['blendshapes']): Record<string, number> {
  if (!blendshapes) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(blendshapes)) if (Number.isFinite(v)) out[k] = v;
  const has = (...names: string[]) => names.every((n) => n in out);
  const avg = (a: string, b: string) => (out[a]! + out[b]!) / 2;
  if (has('browInnerUp', 'browOuterUpLeft', 'browOuterUpRight')) {
    out.brows = Math.max(out.browInnerUp!, avg('browOuterUpLeft', 'browOuterUpRight'));
  }
  if (has('browDownLeft', 'browDownRight')) out.frown = avg('browDownLeft', 'browDownRight');
  if (has('jawOpen')) out.mouthOpen = out.jawOpen!;
  if (has('mouthSmileLeft', 'mouthSmileRight')) out.smile = avg('mouthSmileLeft', 'mouthSmileRight');
  return out;
}

/** 0 open (at `open` or wider) … 1 shut (at `closed` or narrower). */
export function closure(ear: number, open: number, closed: number): number {
  if (!(open > closed)) return ear <= closed ? 1 : 0;
  return Math.min(1, Math.max(0, (open - ear) / (open - closed)));
}

/**
 * The readings: angles relative to the neutral pose (a true composition of rotations,
 * not a subtraction, so a big neutral tilt does not skew the other two), eye closure,
 * and the channels.
 */
export function readings(
  angles: Angles,
  earLeft: number,
  earRight: number,
  chans: Record<string, number>,
  neutral: Neutral,
  eyes: HeadReaderConfig['eyes'],
): Readings {
  const rel = relative(angles, neutral);
  return {
    ...chans,
    yaw: rel.yaw,
    pitch: rel.pitch,
    roll: rel.roll,
    blinkLeft: closure(earLeft, neutral.eyeLeft ?? eyes.open, eyes.closed),
    blinkRight: closure(earRight, neutral.eyeRight ?? eyes.open, eyes.closed),
  };
}

/** `angles` as seen from `neutral` rather than from facing the camera squarely. */
export function relative(angles: Angles, neutral: Angles): Angles {
  if (neutral.yaw === 0 && neutral.pitch === 0 && neutral.roll === 0) return { ...angles };
  const R = fromAngles(angles);
  const N = fromAngles(neutral);
  // R = rel · N, so rel = R · Nᵀ
  const rel = [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[i]![0] * N[j]![0] + R[i]![1] * N[j]![1] + R[i]![2] * N[j]![2])) as Mat3;
  return eulerDegrees(rel);
}

/** The inverse of `eulerDegrees`: R = Ry · Rx · Rz. */
export function fromAngles({ yaw, pitch, roll }: Angles): Mat3 {
  const rad = Math.PI / 180;
  const a = -yaw * rad;
  const b = -pitch * rad;
  const c = roll * rad;
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  // Ry(a) · Rx(b) = [[ca, sa·sb, sa·cb], [0, cb, −sb], [−sa, ca·sb, ca·cb]], then · Rz(c)
  return [
    [ca * cc + sa * sb * sc, -ca * sc + sa * sb * cc, sa * cb],
    [cb * sc, cb * cc, -sb],
    [-sa * cc + ca * sb * sc, sa * sc + ca * sb * cc, ca * cb],
  ];
}
