import type { Features, HandLabel } from 'gesturecore';
import type { HandReading, ReadHand } from './types.js';

/**
 * Every hand, as the chord reader needs it, read live from a GestureCore. Safe to make
 * once and reuse: each call reads the core's state at that moment.
 *
 * The sound brick has the same helper. Copying six lines keeps the bricks independent of
 * each other, which is the point of a brick.
 */
export function readerFor(core: {
  getFeatures(hand: HandLabel): Features | null;
  getHandState(hand: HandLabel): HandReading['state'];
}): ReadHand {
  return (hand) => ({ features: core.getFeatures(hand), state: core.getHandState(hand) });
}
