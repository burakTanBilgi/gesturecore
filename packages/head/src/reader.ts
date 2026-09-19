import { OneEuroFilter, motionProgress, type MotionDescription, type MotionSample } from 'gesturecore';
import { defaultHeadConfig } from './defaults.js';
import { measure, readings, usable, type Angles, type Measured } from './readings.js';
import {
  ANGLES,
  type ExpressionDescription,
  type Face,
  type HeadEvent,
  type HeadMotionDescription,
  type HeadReaderConfig,
  type HeadReaderConfigPatch,
  type HeadState,
  type Neutral,
  type Readings,
} from './types.js';

const DEFAULT_MOTION_COOLDOWN_MS = 500;
const NO_NEUTRAL: Neutral = { yaw: 0, pitch: 0, roll: 0, eyeLeft: null, eyeRight: null };

type ExpressionTrack = { insideSince: number | null; activeSince: number | null; inside: boolean };
type AngleSample = { t: number } & Angles;

/**
 * Reads a face the way the core reads hands: landmarks in, events out, one synchronous
 * call per frame, the caller's clock. An optional brick — the core never knows about it.
 *
 * ```ts
 * const head = new HeadReader({ aspect: 640 / 480 });
 * for (const e of head.update(face, performance.now())) {
 *   if (e.type === 'motion' && e.name === 'nod') confirm();
 *   if (e.type === 'expression:start' && e.name === 'browRaise') louder();
 * }
 * ```
 *
 * Events per frame come as `face`, then `expression:end`s, then `expression:start`s, then
 * `motion`s (each in config order); when the face goes, every active expression ends
 * before `lost`.
 */
export class HeadReader {
  private config: HeadReaderConfig;
  private neutral: Neutral = { ...NO_NEUTRAL };
  private filters: Record<keyof Angles, OneEuroFilter>;
  private found = false;
  private lastSeen = -Infinity;
  private lastT = -Infinity;
  private measured: Measured | null = null;
  private smoothed: Angles | null = null;
  private current: Readings | null = null;
  private tracks = new Map<string, ExpressionTrack>();
  private samples: AngleSample[] = [];
  private motionFloor = -Infinity;
  private motionFired = new Map<string, number>();
  private motionProgress: { name: string; progress: number }[] = [];

  constructor(config: HeadReaderConfigPatch = {}) {
    this.config = checked(merge(defaultHeadConfig(), config));
    const f = () => new OneEuroFilter(this.config.smoothing);
    this.filters = { yaw: f(), pitch: f(), roll: f() };
  }

  /**
   * Advance to time `t` (ms, non-decreasing) with this frame's face, or `null` when none
   * was found. Returns the events of this frame. A frame older than the last one is
   * ignored.
   */
  update(face: Face | null | undefined, t: number): HeadEvent[] {
    if (!(t >= this.lastT)) return [];
    this.lastT = t;
    const events: HeadEvent[] = [];

    if (!usable(face)) {
      if (this.found && t - this.lastSeen > this.config.lostAfterMs) {
        for (const e of this.config.expressions) {
          const tr = this.tracks.get(e.name);
          if (tr?.activeSince != null) events.push({ type: 'expression:end', name: e.name, t, heldMs: t - tr.activeSince });
        }
        events.push({ type: 'lost', t });
        this.forget();
      }
      return events;
    }

    if (!this.found) {
      this.found = true;
      this.motionFloor = t;
      events.push({ type: 'face', t });
    }
    this.lastSeen = t;

    const m = measure(face, this.config);
    this.measured = m;
    this.smoothed = {
      yaw: this.filters.yaw.filter(m.angles.yaw, t),
      pitch: this.filters.pitch.filter(m.angles.pitch, t),
      roll: this.filters.roll.filter(m.angles.roll, t),
    };
    const r = readings(this.smoothed, m.earLeft, m.earRight, m.channels, this.neutral, this.config.eyes);
    this.current = r;

    this.expressions(r, t, events);
    this.motions(r, t, events);
    return events;
  }

  /** The latest readings, or `null` when no face is in view. */
  getReadings(): Readings | null {
    return this.current ? { ...this.current } : null;
  }

  getState(): HeadState {
    const t = this.lastT;
    return {
      found: this.found,
      expressions: this.config.expressions.map((e) => {
        const tr = this.tracks.get(e.name);
        const dwell = e.dwellMs ?? this.config.dwellMs;
        const active = tr?.activeSince != null;
        const progress = active
          ? 1
          : tr?.insideSince != null
            ? dwell > 0
              ? Math.min(1, (t - tr.insideSince) / dwell)
              : 1
            : 0;
        return { name: e.name, progress, active, inside: tr?.inside ?? false };
      }),
      motions: this.motionProgress.map((p) => ({ ...p })),
    };
  }

  /**
   * Take the face as it is now as neutral: its angles read zero from here on, and its eyes
   * count as fully open. Call it while the user looks at the screen in their usual way.
   * Returns false (and changes nothing) when there is no face to take.
   */
  calibrate(): boolean {
    if (!this.found || !this.smoothed || !this.measured) return false;
    this.neutral = { ...this.smoothed, eyeLeft: this.measured.earLeft, eyeRight: this.measured.earRight };
    return true;
  }

  getNeutral(): Neutral {
    return { ...this.neutral };
  }

  /** Set the neutral directly, for instance one saved from an earlier `calibrate()`. */
  setNeutral(neutral: Partial<Neutral>): void {
    this.neutral = { ...this.neutral, ...neutral };
  }

  getConfig(): HeadReaderConfig {
    return JSON.parse(JSON.stringify(this.config)) as HeadReaderConfig;
  }

  /** Throws on a config it cannot use, before anything changes. */
  setConfig(patch: HeadReaderConfigPatch): void {
    this.config = checked(merge(this.getConfig(), patch));
    if (patch.smoothing) for (const f of Object.values(this.filters)) f.setParams(this.config.smoothing);
    // Expressions and motions that no longer exist take their timers with them.
    const names = new Set(this.config.expressions.map((e) => e.name));
    for (const name of this.tracks.keys()) if (!names.has(name)) this.tracks.delete(name);
  }

  /** Forget the face and every timer; keeps the config and the neutral. */
  reset(): void {
    this.forget();
    this.lastT = -Infinity;
  }

  private forget(): void {
    this.found = false;
    this.lastSeen = -Infinity;
    this.measured = null;
    this.smoothed = null;
    this.current = null;
    this.tracks.clear();
    this.samples = [];
    this.motionFired.clear();
    this.motionProgress = [];
    for (const f of Object.values(this.filters)) f.reset();
  }

  private expressions(r: Readings, t: number, events: HeadEvent[]): void {
    const starts: HeadEvent[] = [];
    for (const e of this.config.expressions) {
      let tr = this.tracks.get(e.name);
      if (!tr) this.tracks.set(e.name, (tr = { insideSince: null, activeSince: null, inside: false }));
      const active = tr.activeSince !== null;
      tr.inside = holds(e, r, active ? this.config.hysteresis : null);
      if (!tr.inside) {
        if (active) events.push({ type: 'expression:end', name: e.name, t, heldMs: t - tr.activeSince! });
        tr.insideSince = null;
        tr.activeSince = null;
        continue;
      }
      tr.insideSince ??= t;
      if (!active && t - tr.insideSince >= (e.dwellMs ?? this.config.dwellMs)) {
        tr.activeSince = t;
        starts.push({ type: 'expression:start', name: e.name, t });
      }
    }
    events.push(...starts);
  }

  private motions(r: Readings, t: number, events: HeadEvent[]): void {
    const c = this.config;
    this.samples.push({ t, yaw: r.yaw, pitch: r.pitch, roll: r.roll });
    let keepMs = 0;
    for (const m of c.motions) keepMs = Math.max(keepMs, Number.isFinite(m.withinMs) ? m.withinMs : 0);
    while (this.samples.length > 1 && this.samples[0]!.t < t - keepMs) this.samples.shift();

    this.motionProgress = c.motions.map((m) => {
      const since = Math.max(this.motionFloor, this.motionFired.get(m.name) ?? -Infinity);
      // The core's stroke detector, reused: one axis, in degrees, with no hand-size scaling.
      const series: MotionSample[] = this.samples.map((s) => ({ t: s.t, x: s[m.axis], y: 0, span: 1, tilt: 0, pose: null }));
      return { name: m.name, progress: motionProgress(series, asCoreMotion(m), since) };
    });
    c.motions.forEach((m, i) => {
      if (this.motionProgress[i]!.progress < 1) return;
      const last = this.motionFired.get(m.name);
      if (last !== undefined && t - last < (m.cooldownMs ?? DEFAULT_MOTION_COOLDOWN_MS)) return;
      this.motionFired.set(m.name, t);
      events.push({ type: 'motion', name: m.name, t });
    });
  }
}

function asCoreMotion(m: HeadMotionDescription): MotionDescription {
  return {
    name: m.name,
    axis: 'x',
    distance: m.distance,
    withinMs: m.withinMs,
    ...(m.direction !== undefined && { direction: m.direction }),
    ...(m.reversals !== undefined && { reversals: m.reversals }),
  };
}

/**
 * Every range of `e` holds for `r`. With `margin` (the expression is already active) each
 * range is widened by the hysteresis, so a reading resting on a boundary cannot flicker.
 * A reading the face does not have (no blendshapes) never holds.
 */
export function holds(e: ExpressionDescription, r: Readings, margin: HeadReaderConfig['hysteresis'] | null): boolean {
  for (const [channel, range] of Object.entries(e.when)) {
    const v = r[channel];
    if (v === undefined || !Number.isFinite(v)) return false;
    const h = margin ? ((ANGLES as readonly string[]).includes(channel) ? margin.degrees : margin.level) : 0;
    if (v < range[0] - h || v > range[1] + h) return false;
  }
  return true;
}

function merge(base: HeadReaderConfig, patch: HeadReaderConfigPatch): HeadReaderConfig {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && !Array.isArray(v) ? { ...cur, ...(v as object) } : v;
  }
  return out as unknown as HeadReaderConfig;
}

function checked(c: HeadReaderConfig): HeadReaderConfig {
  if (!(c.aspect > 0)) throw new Error(`aspect must be a positive number (frame width / height), not ${String(c.aspect)}`);
  if (!(c.eyes.open > c.eyes.closed)) throw new Error('eyes.open must be larger than eyes.closed');
  for (const e of c.expressions) {
    for (const [channel, range] of Object.entries(e.when)) {
      if (!Array.isArray(range) || range.length !== 2 || !(range[0] <= range[1])) {
        throw new Error(`expression "${e.name}": ${channel} must be a [low, high] range`);
      }
    }
  }
  for (const m of c.motions) {
    if (!(ANGLES as readonly string[]).includes(m.axis)) throw new Error(`motion "${m.name}": axis must be yaw, pitch or roll`);
  }
  return c;
}
