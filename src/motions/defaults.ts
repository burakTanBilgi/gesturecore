import type { MotionDescription } from '../types.js';

/** Directions assume a mirrored (selfie) input frame, where +x is the user's right. */
export const SWIPE_LEFT: MotionDescription = { name: 'swipeLeft', axis: 'x', direction: -1, distance: 1.5, withinMs: 400 };

export const SWIPE_RIGHT: MotionDescription = { name: 'swipeRight', axis: 'x', direction: 1, distance: 1.5, withinMs: 400 };

/** Open palm moved side to side: four strokes of at least half a hand. */
export const WAVE: MotionDescription = {
  name: 'wave',
  axis: 'x',
  distance: 0.5,
  withinMs: 1500,
  reversals: 3,
  pose: 'openPalm',
  cooldownMs: 1000,
};

export const DEFAULT_MOTIONS: readonly MotionDescription[] = [SWIPE_LEFT, SWIPE_RIGHT, WAVE];
