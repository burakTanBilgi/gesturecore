import type { GestureCoreConfig, Landmark } from '../types.js';

export type OneEuroParams = GestureCoreConfig['smoothing'];

/**
 * One Euro filter (Casiez, Roussel, Vogel 2012) for a single scalar.
 *
 * Adaptive low-pass: the cutoff rises with the (smoothed) speed of the signal,
 * so it smooths heavily at rest and lags little during fast motion.
 *   cutoff = minCutoff + beta * |dx/dt|
 * Time is milliseconds, passed in; internally rates are per second. No globals.
 */
export class OneEuroFilter {
  private params: OneEuroParams;
  private x = 0;
  private dx = 0;
  private lastT = 0;
  private primed = false;

  constructor(params: OneEuroParams) {
    this.params = { ...params };
  }

  /** Change parameters without discarding filter state. */
  setParams(params: OneEuroParams): void {
    this.params = { ...params };
  }

  reset(): void {
    this.primed = false;
    this.x = 0;
    this.dx = 0;
    this.lastT = 0;
  }

  /** Current output without feeding a new sample. */
  value(): number {
    return this.x;
  }

  filter(value: number, tMs: number): number {
    if (!this.primed) {
      this.primed = true;
      this.x = value;
      this.dx = 0;
      this.lastT = tMs;
      return value;
    }
    const dt = (tMs - this.lastT) / 1000;
    // Duplicate or out-of-order timestamp: no time has passed, so nothing can change.
    if (!(dt > 0)) return this.x;
    this.lastT = tMs;

    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (value - this.x) / dt;
    this.dx += smoothingFactor(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += smoothingFactor(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Exponential smoothing factor for a first-order low-pass at `cutoff` Hz over `dt` seconds. */
export function smoothingFactor(cutoff: number, dt: number): number {
  if (!(cutoff > 0)) return 0;
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** One Euro filter per coordinate of a 21-landmark hand (63 independent filters). */
export class LandmarkSmoother {
  private filters: OneEuroFilter[] = [];

  constructor(private params: OneEuroParams) {}

  setParams(params: OneEuroParams): void {
    this.params = { ...params };
    for (const f of this.filters) f.setParams(params);
  }

  reset(): void {
    this.filters = [];
  }

  filter(landmarks: readonly Landmark[], tMs: number): Landmark[] {
    const need = landmarks.length * 3;
    if (this.filters.length !== need) {
      this.filters = Array.from({ length: need }, () => new OneEuroFilter(this.params));
    }
    return landmarks.map((p, i) => ({
      x: this.filters[i * 3]!.filter(p.x, tMs),
      y: this.filters[i * 3 + 1]!.filter(p.y, tMs),
      z: this.filters[i * 3 + 2]!.filter(p.z, tMs),
    }));
  }
}
