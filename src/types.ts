/**
 * Public types for gesturecore.
 *
 * ── Conventions (decided once, used everywhere) ──────────────────────────────
 *
 * HANDEDNESS is anatomical: 'Right' means the user's actual right hand.
 *   MediaPipe's label depends on whether the frame it saw was mirrored, so the
 *   *source adapter* is responsible for producing the anatomical label before
 *   calling `update()`. The core never flips handedness. Observed with
 *   @mediapipe/tasks-vision 1.0.1 on a laptop webcam: feeding the unmirrored
 *   camera frame yields the anatomical label as-is (no flip needed).
 *
 * COORDINATES are MediaPipe-normalised image coordinates: x and y in [0, 1]
 *   across the frame the adapter chose to hand us (y grows downward), z relative
 *   to the wrist on roughly the same scale as x. Whether that frame is mirrored
 *   is the adapter's choice; the bench feeds a mirrored ("selfie") frame so
 *   screen-right equals the user's right. Only `tilt` and `centroid` are
 *   frame-dependent; every other feature is invariant to mirroring.
 *
 * ASPECT: normalised x and y have different pixel scales on a non-square
 *   frame, which would distort every distance ratio. Set `config.aspect` to
 *   frame width / height and the core corrects for it internally. Fixtures are
 *   stored already isotropic, so tests run with `aspect = 1`.
 *
 * Z is noisy relative depth. It is used only inside joint angles (curl), never
 *   as an absolute distance. Use `span` for distance-to-camera estimation.
 *
 * TIME is milliseconds, supplied by the caller, and must be non-decreasing.
 */

export type HandLabel = 'Left' | 'Right';

export type Landmark = { x: number; y: number; z: number };

export type Hand = {
  /** Exactly 21 MediaPipe hand landmarks. */
  landmarks: Landmark[];
  /** Anatomical hand, see the handedness convention above. */
  handedness: HandLabel;
  /** Handedness confidence from MediaPipe, 0..1. */
  score: number;
};

export type Features = {
  /** 0 = closed, 1 = fully open, scale-invariant. */
  pinch: number;
  /** 0 = fist, 1 = all four fingers straight. Mean extension of index..pinky. */
  openness: number;
  /** Per finger, 0 = straight, 1 = fully bent, thumb→pinky. */
  curls: number[];
  /**
   * Radians, palm rotation in the image plane: direction of wrist → middle MCP.
   * 0 = fingers pointing up the frame, positive = rotated toward +x. Range (-π, π].
   */
  tilt: number;
  /** Palm centre (mean of wrist and the four finger MCPs), in input coordinates. */
  centroid: { x: number; y: number };
  /** Wrist → middle MCP length, aspect-corrected. Larger = closer to the camera. */
  span: number;
  /** Unnormalised thumb-tip ↔ index-tip distance / span. What pinch thresholds compare against. */
  pinchRaw: number;
  /** Thumb-tip ↔ fingertip distance / span for every finger the thumb can pinch. `pinchRaws.index === pinchRaw`. */
  pinchRaws: Record<PinchFinger, number>;
};

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

/** A finger the thumb can pinch against. */
export type PinchFinger = Exclude<FingerName, 'thumb'>;

export type PoseDescription = {
  name: string;
  /** Inclusive [min, max] curl range per finger, 0..1. Unlisted fingers are ignored. */
  fingers: Partial<Record<FingerName, { curl?: [number, number] }>>;
  /** Minimum score for the pose to count as held. Default 0.8. */
  minScore?: number;
};

export type PoseMatch = { name: string; score: number };

export type GestureEvent =
  | { type: 'engage' | 'disengage'; hand: HandLabel; t: number }
  | { type: 'pinch:start' | 'pinch:end'; hand: HandLabel; finger: PinchFinger; t: number }
  /** `value` is the normalised pinch (0 closed … 1 open) of the finger that started the pinch. */
  | { type: 'pinch:move'; hand: HandLabel; finger: PinchFinger; value: number; t: number }
  | { type: 'pose'; hand: HandLabel; name: string; t: number }
  | { type: 'lost'; hand: HandLabel; t: number };

export type GestureEventType = GestureEvent['type'];

export interface GestureCoreConfig {
  /** One Euro filter, applied per landmark coordinate before feature extraction. */
  smoothing: { minCutoff: number; beta: number; dCutoff: number };
  /**
   * Thresholds on thumb ↔ fingertip distance / span. Closes below closed+h, releases above closed+3h.
   * `fingers` lists which fingers may pinch. While closing, the closest enabled finger is the candidate;
   * once pinch:start fires, that finger is locked until pinch:end.
   */
  pinch: { closed: number; open: number; hysteresis: number; fingers: PinchFinger[] };
  /**
   * Hold `pose` for `dwellMs` to engage a hand. Pinch events only fire while engaged.
   * An empty pose name engages a hand as soon as it appears.
   */
  engage: { pose: string; dwellMs: number };
  /** How long a pose or a pinch must hold before its event fires. */
  dwellMs: number;
  /** A hand absent for longer than this is reported lost and its state cleared. */
  lostAfterMs: number;
  poses: PoseDescription[];
  /** Curl angle mapping, radians at the PIP joint (IP joint for the thumb). */
  curl: { straight: number; bent: number; thumbStraight: number; thumbBent: number };
  /** Per-finger fit falls from 1 to 0 over this curl distance outside the range. */
  poseFalloff: number;
  /** Frame width / height of the landmark source. */
  aspect: number;
}

/** Partial config where each section may itself be partial. */
export type GestureCoreConfigPatch = {
  [K in keyof GestureCoreConfig]?: GestureCoreConfig[K] extends unknown[]
    ? GestureCoreConfig[K]
    : GestureCoreConfig[K] extends object
      ? Partial<GestureCoreConfig[K]>
      : GestureCoreConfig[K];
};

/** Read-only snapshot of one hand's state machine, for UIs such as the bench. */
export type HandState = {
  engaged: boolean;
  /** 0..1 progress toward engaging (1 once engaged). */
  engageProgress: number;
  pinched: boolean;
  /** Hysteresis state: the thumb is closed on a finger, whether or not dwell has completed. */
  pinchClosed: boolean;
  /** The finger the thumb is closed on (candidate during dwell, locked once pinched), or null. */
  pinchFinger: PinchFinger | null;
  /** 0..1 progress toward pinch:start. */
  pinchProgress: number;
  /** Best pose currently held (above its minScore), or null. */
  pose: string | null;
  /** 0..1 progress toward the pose event for `pose`. */
  poseProgress: number;
  /** Scores for every configured pose, in config order. */
  poseScores: PoseMatch[];
  /** Timestamp the hand was last present. */
  lastSeen: number;
};
