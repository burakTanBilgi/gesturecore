import type { Landmark } from 'gesturecore';

/**
 * One face, as a face tracker reports it. `landmarks` are the MediaPipe Face Mesh points
 * (468, or 478 with the irises), normalised to the frame like the hand landmarks.
 * `blendshapes` are the optional expression scores 0..1 by name (MediaPipe's 52, such as
 * `browInnerUp` or `jawOpen`); without them only the head angles and the eyes are read.
 */
export type Face = {
  landmarks: readonly Landmark[];
  blendshapes?: Readonly<Record<string, number>>;
};

/**
 * What the reader measures each frame. Angles are degrees, relative to the neutral pose
 * (facing the camera squarely, unless `calibrate()` recorded another one); the others are
 * levels 0..1. `brows`, `frown`, `mouthOpen` and `smile` are present only when the face
 * came with blendshapes, and so is every raw blendshape, under its own name.
 */
export type Readings = {
  /** Turning: + toward the user's own right. */
  yaw: number;
  /** Nodding: + looking up. */
  pitch: number;
  /** Tilting: + toward the user's right shoulder. */
  roll: number;
  /** Eye closure from the landmarks: 0 as open as when calibrated, 1 shut. Per anatomical eye. */
  blinkLeft: number;
  blinkRight: number;
  /** Eyebrows raised (the stronger of the inner and outer raise). */
  brows?: number;
  /** Eyebrows pulled down. */
  frown?: number;
  mouthOpen?: number;
  smile?: number;
  [channel: string]: number | undefined;
};

/** Readings that are angles (degrees); every other reading is a level. */
export const ANGLES = ['yaw', 'pitch', 'roll'] as const;
export type Angle = (typeof ANGLES)[number];

/**
 * A held face state, declared as ranges on readings — like a hand pose, but for the face.
 * All ranges must hold at once. `[lo, hi]` in the reading's unit: degrees for angles,
 * 0..1 for levels.
 *
 * ```json
 * { "name": "browRaise", "when": { "brows": [0.45, 1] } }
 * { "name": "tiltLeft",  "when": { "roll": [-90, -15] } }
 * ```
 */
export type ExpressionDescription = {
  name: string;
  when: Record<string, readonly [number, number]>;
  /** How long it must hold before `expression:start`. Default: the config's `dwellMs`. */
  dwellMs?: number;
};

/**
 * A head movement: strokes of an angle, like a hand movement but in degrees.
 *
 * ```json
 * { "name": "nod",   "axis": "pitch", "reversals": 1, "distance": 8,  "withinMs": 900 }
 * { "name": "shake", "axis": "yaw",   "reversals": 2, "distance": 10, "withinMs": 1200 }
 * ```
 */
export type HeadMotionDescription = {
  name: string;
  axis: Angle;
  /** Sign of a single stroke (+1 = the reading's + direction). Ignored when `reversals` > 0. */
  direction?: 1 | -1;
  /** Minimum travel of every stroke, degrees. */
  distance: number;
  /** All strokes within this many milliseconds. */
  withinMs: number;
  /** Direction changes required: 0 = one stroke, 1 = down-and-up (a nod), 2 = a shake. */
  reversals?: number;
  /** Minimum time before it can fire again. Default 500. */
  cooldownMs?: number;
};

export interface HeadReaderConfig {
  /** Frame width / height. Required for non-square frames, or every angle is distorted. */
  aspect: number;
  /** Set when the frames are mirrored (a selfie view); raw camera frames are not. */
  mirrored: boolean;
  /** One Euro filter on the three angles (degrees). */
  smoothing: { minCutoff: number; beta: number; dCutoff: number };
  /** Eye aspect ratio of an open and of a shut eye, until `calibrate()` measures the open one. */
  eyes: { open: number; closed: number };
  /** Release margins: a range, once entered, is left only this far outside it. */
  hysteresis: { level: number; degrees: number };
  /** Default hold before an expression starts. */
  dwellMs: number;
  /** A face absent this long is lost. */
  lostAfterMs: number;
  expressions: ExpressionDescription[];
  motions: HeadMotionDescription[];
}

export type HeadReaderConfigPatch = {
  [K in keyof HeadReaderConfig]?: HeadReaderConfig[K] extends unknown[]
    ? HeadReaderConfig[K]
    : HeadReaderConfig[K] extends object
      ? Partial<HeadReaderConfig[K]>
      : HeadReaderConfig[K];
};

/** The neutral pose: where the angles read zero, and how open the eyes are at rest. */
export type Neutral = { yaw: number; pitch: number; roll: number; eyeLeft: number | null; eyeRight: number | null };

export type HeadEvent =
  | { type: 'face'; t: number }
  | { type: 'expression:start'; name: string; t: number }
  | { type: 'expression:end'; name: string; t: number; heldMs: number }
  | { type: 'motion'; name: string; t: number }
  | { type: 'lost'; t: number };

export type HeadEventType = HeadEvent['type'];

export type ExpressionState = {
  name: string;
  /** 0..1: how far into its dwell (1 while active). */
  progress: number;
  active: boolean;
  /** Every range currently satisfied. */
  inside: boolean;
};

export type HeadState = {
  found: boolean;
  expressions: ExpressionState[];
  motions: { name: string; progress: number }[];
};
