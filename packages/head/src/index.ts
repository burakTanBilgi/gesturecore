export { HeadReader, holds } from './reader.js';
export { DEFAULT_EXPRESSIONS, DEFAULT_HEAD_CONFIG, DEFAULT_HEAD_MOTIONS, NOD, SHAKE, defaultHeadConfig } from './defaults.js';
export { faceFromMediaPipe } from './mediapipe.js';
export { channels, closure, fromAngles, measure, readings, relative, usable } from './readings.js';
export { eulerDegrees, eyeAspect, headRotation } from './pose.js';
export { ANCHORS, EYES } from './canonical.js';
export { ANGLES } from './types.js';
export type { FaceLandmarkerResultLike } from './mediapipe.js';
export type { Angles, Measured } from './readings.js';
export type { Mat3, Vec3 } from './pose.js';
export type {
  Angle,
  ExpressionDescription,
  ExpressionState,
  Face,
  HeadEvent,
  HeadEventType,
  HeadMotionDescription,
  HeadReaderConfig,
  HeadReaderConfigPatch,
  HeadState,
  Neutral,
  Readings,
} from './types.js';
