import type { PoseDescription } from '../types.js';

export const FIST: PoseDescription = {
  name: 'fist',
  fingers: {
    index: { curl: [0.75, 1] },
    middle: { curl: [0.75, 1] },
    ring: { curl: [0.75, 1] },
    pinky: { curl: [0.75, 1] },
  },
};

/** Thumb is left out: its curl is noisy and a relaxed open palm holds it anywhere. */
export const OPEN_PALM: PoseDescription = {
  name: 'openPalm',
  fingers: {
    index: { curl: [0, 0.25] },
    middle: { curl: [0, 0.25] },
    ring: { curl: [0, 0.25] },
    pinky: { curl: [0, 0.25] },
  },
};

export const POINT: PoseDescription = {
  name: 'point',
  fingers: {
    index: { curl: [0, 0.25] },
    middle: { curl: [0.6, 1] },
    ring: { curl: [0.6, 1] },
    pinky: { curl: [0.6, 1] },
  },
};

export const DEFAULT_POSES: readonly PoseDescription[] = [FIST, OPEN_PALM, POINT];
