import type { ExpressionDescription, HeadMotionDescription, HeadReaderConfig } from './types.js';

/**
 * The expressions read out of the box. Like the core's poses they are only defaults:
 * replace them with `setConfig({ expressions })`. The thresholds are first guesses, to be
 * tuned against real faces in the bench.
 */
export const DEFAULT_EXPRESSIONS: ExpressionDescription[] = [
  { name: 'browRaise', when: { brows: [0.45, 1] } },
  { name: 'frown', when: { frown: [0.4, 1] } },
  { name: 'mouthOpen', when: { mouthOpen: [0.35, 1] } },
  { name: 'smile', when: { smile: [0.5, 1] } },
  // A blink is short, so it needs no hold; a wink must outlast one to count.
  { name: 'blink', when: { blinkLeft: [0.6, 1], blinkRight: [0.6, 1] }, dwellMs: 0 },
  { name: 'winkLeft', when: { blinkLeft: [0.6, 1], blinkRight: [0, 0.3] }, dwellMs: 200 },
  { name: 'winkRight', when: { blinkRight: [0.6, 1], blinkLeft: [0, 0.3] }, dwellMs: 200 },
  { name: 'turnLeft', when: { yaw: [-90, -20] } },
  { name: 'turnRight', when: { yaw: [20, 90] } },
  { name: 'lookUp', when: { pitch: [15, 90] } },
  { name: 'lookDown', when: { pitch: [-90, -15] } },
  { name: 'tiltLeft', when: { roll: [-90, -15] } },
  { name: 'tiltRight', when: { roll: [15, 90] } },
];

/** A nod is down and back up; a shake is side, side, side. */
export const NOD: HeadMotionDescription = { name: 'nod', axis: 'pitch', reversals: 1, distance: 8, withinMs: 900 };
export const SHAKE: HeadMotionDescription = { name: 'shake', axis: 'yaw', reversals: 2, distance: 10, withinMs: 1200 };
export const DEFAULT_HEAD_MOTIONS: HeadMotionDescription[] = [NOD, SHAKE];

export const DEFAULT_HEAD_CONFIG: HeadReaderConfig = {
  aspect: 1,
  mirrored: false,
  smoothing: { minCutoff: 1.2, beta: 0.05, dCutoff: 1 },
  eyes: { open: 0.28, closed: 0.12 },
  hysteresis: { level: 0.08, degrees: 4 },
  dwellMs: 250,
  lostAfterMs: 300,
  expressions: DEFAULT_EXPRESSIONS,
  motions: DEFAULT_HEAD_MOTIONS,
};

/** A fresh copy of the defaults, safe to change. */
export function defaultHeadConfig(): HeadReaderConfig {
  return JSON.parse(JSON.stringify(DEFAULT_HEAD_CONFIG)) as HeadReaderConfig;
}
