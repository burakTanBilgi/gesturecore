export { GestureCore } from './state/machine.js';
export { DEFAULT_CONFIG, defaultConfig } from './config.js';
export { DEFAULT_POSES, FIST, OPEN_PALM, POINT } from './poses/defaults.js';
export { PINCH_FINGERS } from './features/extract.js';
export type {
  Features,
  FingerName,
  GestureCoreConfig,
  GestureCoreConfigPatch,
  GestureEvent,
  GestureEventType,
  Hand,
  HandLabel,
  HandState,
  Landmark,
  PinchFinger,
  PoseDescription,
  PoseMatch,
} from './types.js';
