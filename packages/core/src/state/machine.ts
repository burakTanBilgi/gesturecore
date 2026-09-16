import { defaultConfig, mergeConfig } from '../config.js';
import { extractFeatures, PINCH_FINGERS } from '../features/extract.js';
import { LANDMARK_COUNT, unlerp } from '../features/geometry.js';
import { LandmarkSmoother } from '../filter/oneEuro.js';
import { motionProgress, type MotionSample } from '../motions/detect.js';
import { bestPose, matchPoses } from '../poses/match.js';
import type {
  Features,
  GestureCoreConfig,
  GestureCoreConfigPatch,
  GestureEvent,
  Hand,
  HandLabel,
  HandState,
  MotionProgress,
  PinchFinger,
  PoseMatch,
} from '../types.js';

/** Longest movement history kept per hand, whatever withinMs says. */
const MAX_MOTION_WINDOW_MS = 10_000;
const DEFAULT_MOTION_COOLDOWN_MS = 500;

/**
 * The only stateful module in gesturecore.
 *
 * Per frame, per hand (always Left before Right):
 *   present → smooth landmarks → extract features → score poses → advance timers
 *   absent  → after more than lostAfterMs, close everything and forget the hand
 *
 * Event ordering within one hand's frame:
 *   engage, pinch:end, pinch:start | pinch:move, pose, motion (in config order)
 * and on loss:
 *   pinch:end (if pinched), disengage (if engaged), lost
 *
 * Guarantees:
 *   - every pinch:start is followed by exactly one pinch:end, and every engage by
 *     exactly one disengage, before that hand's `lost` (reset() drops state silently)
 *   - a hand that disappears for lostAfterMs or less keeps all its state; dwell
 *     timers are timestamp-based and keep running across the gap
 */

const LABELS: readonly HandLabel[] = ['Left', 'Right'];

type Track = {
  smoother: LandmarkSmoother;
  features: Features;
  poseScores: PoseMatch[];
  lastSeen: number;

  engaged: boolean;
  engagedAt: number;
  /** When the engage pose started being held continuously, while not engaged. */
  engageSince: number | null;

  /**
   * Hysteresis state: the finger the thumb is closed on, or null when open.
   * Before pinch:start it follows the closest enabled finger; after, it is locked.
   */
  pinchFinger: PinchFinger | null;
  pinchSince: number;
  /** pinch:start has been emitted and pinch:end has not. */
  pinched: boolean;

  pose: string | null;
  poseSince: number;
  poseFired: boolean;

  /** Recent palm movement, oldest first. */
  samples: MotionSample[];
  /** Movement before this time does not count (last frame that was not engaged, or had a pinch closed). */
  motionFloor: number;
  /** Last time each motion fired; movement before it has been used up. */
  motionFired: Map<string, number>;
  motionProgress: MotionProgress[];
};

function isValidHand(h: Hand): boolean {
  if (h.handedness !== 'Left' && h.handedness !== 'Right') return false;
  if (!Array.isArray(h.landmarks) || h.landmarks.length !== LANDMARK_COUNT) return false;
  return h.landmarks.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
}

function progress(elapsed: number, dwellMs: number): number {
  if (!(dwellMs > 0)) return 1;
  return Math.min(1, Math.max(0, elapsed / dwellMs));
}

export class GestureCore {
  private config: GestureCoreConfig;
  private tracks = new Map<HandLabel, Track>();
  private now = 0;

  constructor(config?: GestureCoreConfigPatch) {
    this.config = mergeConfig(defaultConfig(), config);
  }

  /**
   * Feed one frame. `t` is milliseconds from any clock the caller likes, non-decreasing.
   * Returns the events this frame produced, possibly none.
   */
  update(hands: readonly Hand[], t: number): GestureEvent[] {
    this.now = t;
    const events: GestureEvent[] = [];
    const present = this.pickHands(hands);

    for (const label of LABELS) {
      const hand = present.get(label);
      if (hand) {
        this.step(label, hand, t, events);
      } else {
        this.checkLost(label, t, events);
      }
    }
    return events;
  }

  getFeatures(hand: HandLabel): Features | null {
    return this.tracks.get(hand)?.features ?? null;
  }

  /** Snapshot of one hand's state machine, including in-flight dwell progress. Null if not tracked. */
  getHandState(hand: HandLabel): HandState | null {
    const tr = this.tracks.get(hand);
    if (!tr) return null;
    const c = this.config;
    return {
      engaged: tr.engaged,
      engageProgress: tr.engaged
        ? 1
        : tr.engageSince === null
          ? 0
          : progress(this.now - tr.engageSince, c.engage.dwellMs),
      pinched: tr.pinched,
      pinchClosed: tr.pinchFinger !== null,
      pinchFinger: tr.pinchFinger,
      pinchProgress: tr.pinched
        ? 1
        : tr.pinchFinger !== null && tr.engaged
          ? progress(this.now - Math.max(tr.pinchSince, tr.engagedAt), c.dwellMs)
          : 0,
      pose: tr.pose,
      poseProgress: tr.pose === null ? 0 : tr.poseFired ? 1 : progress(this.now - tr.poseSince, c.dwellMs),
      poseScores: tr.poseScores.map((m) => ({ ...m })),
      motionProgress: tr.motionProgress.map((m) => ({ ...m })),
      lastSeen: tr.lastSeen,
    };
  }

  /** A JSON-safe copy of the active config. */
  getConfig(): GestureCoreConfig {
    return mergeConfig(this.config, undefined);
  }

  /** Apply a partial config immediately. In-flight timers and filter state are kept. */
  setConfig(patch: GestureCoreConfigPatch): void {
    this.config = mergeConfig(this.config, patch);
    for (const tr of this.tracks.values()) tr.smoother.setParams(this.config.smoothing);
  }

  /** Forget every hand. Emits nothing. */
  reset(): void {
    this.tracks.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** One valid hand per label; if a label appears twice, the higher score wins (first on ties). */
  private pickHands(hands: readonly Hand[]): Map<HandLabel, Hand> {
    const out = new Map<HandLabel, Hand>();
    for (const h of hands) {
      if (!isValidHand(h)) continue;
      const prev = out.get(h.handedness);
      if (!prev || h.score > prev.score) out.set(h.handedness, h);
    }
    return out;
  }

  private step(label: HandLabel, hand: Hand, t: number, events: GestureEvent[]): void {
    const c = this.config;
    let tr = this.tracks.get(label);
    const smoother = tr?.smoother ?? new LandmarkSmoother(c.smoothing);
    const features = extractFeatures(smoother.filter(hand.landmarks, t), c);
    const poseScores = matchPoses(features, c.poses, c.poseFalloff);
    const best = bestPose(poseScores, c.poses)?.name ?? null;

    if (!tr) {
      tr = {
        smoother,
        features,
        poseScores,
        lastSeen: t,
        engaged: false,
        engagedAt: t,
        engageSince: null,
        pinchFinger: null,
        pinchSince: t,
        pinched: false,
        pose: null,
        poseSince: t,
        poseFired: false,
        samples: [],
        motionFloor: t,
        motionFired: new Map(),
        motionProgress: [],
      };
      this.tracks.set(label, tr);
    }
    tr.features = features;
    tr.poseScores = poseScores;
    tr.lastSeen = t;

    // Engage: hold the engage pose for engage.dwellMs. Only loss disengages.
    if (!tr.engaged) {
      if (c.engage.pose === '') {
        this.engage(tr, label, t, events);
      } else if (best === c.engage.pose) {
        tr.engageSince ??= t;
        if (t - tr.engageSince >= c.engage.dwellMs) this.engage(tr, label, t, events);
      } else {
        tr.engageSince = null;
      }
    }

    // Pinch: two-threshold hysteresis on thumb ↔ fingertip distance, then dwell before start.
    const h = c.pinch.hysteresis;
    const closeBelow = c.pinch.closed + h;
    const releaseAbove = c.pinch.closed + 3 * h;
    const raws = features.pinchRaws;
    const enabled = PINCH_FINGERS.filter((f) => c.pinch.fingers.includes(f));
    let closest: PinchFinger | null = null;
    for (const f of enabled) if (closest === null || raws[f] < raws[closest]) closest = f;

    if (tr.pinchFinger !== null) {
      // During dwell the thumb may settle on a neighbouring finger without restarting the timer.
      if (!tr.pinched && closest !== null) tr.pinchFinger = closest;
      const disabled = !enabled.includes(tr.pinchFinger);
      if (disabled || raws[tr.pinchFinger] > releaseAbove) {
        if (tr.pinched) {
          tr.pinched = false;
          events.push({ type: 'pinch:end', hand: label, finger: tr.pinchFinger, t });
        }
        tr.pinchFinger = null;
      }
    }
    if (tr.pinchFinger === null && closest !== null && raws[closest] < closeBelow) {
      tr.pinchFinger = closest;
      tr.pinchSince = t;
    }
    if (tr.pinched && tr.pinchFinger !== null) {
      const value = unlerp(raws[tr.pinchFinger], c.pinch.closed, c.pinch.open);
      events.push({ type: 'pinch:move', hand: label, finger: tr.pinchFinger, value, t });
    } else if (tr.pinchFinger !== null && tr.engaged && t - Math.max(tr.pinchSince, tr.engagedAt) >= c.dwellMs) {
      tr.pinched = true;
      events.push({ type: 'pinch:start', hand: label, finger: tr.pinchFinger, t });
    }

    // Pose: the best qualifying pose must hold for dwellMs; fires once per hold.
    if (best !== tr.pose) {
      tr.pose = best;
      tr.poseSince = t;
      tr.poseFired = false;
    }
    if (tr.pose !== null && !tr.poseFired && t - tr.poseSince >= c.dwellMs) {
      tr.poseFired = true;
      events.push({ type: 'pose', hand: label, name: tr.pose, t });
    }

    // Motions: movement history → per-motion progress; fire at 1, then that movement is used up.
    const aspect = c.aspect > 0 ? c.aspect : 1;
    tr.samples.push({ t, x: features.centroid.x * aspect, y: features.centroid.y, span: features.span, tilt: features.tilt, pose: best });
    let keepMs = 0;
    for (const m of c.motions) keepMs = Math.max(keepMs, Number.isFinite(m.withinMs) ? m.withinMs : 0);
    keepMs = Math.min(keepMs, MAX_MOTION_WINDOW_MS);
    let drop = 0;
    while (drop < tr.samples.length - 1 && tr.samples[drop]!.t < t - keepMs) drop++;
    if (drop > 0) tr.samples.splice(0, drop);

    // Pinch-drag owns hand movement, and un-engaged movement never counts.
    const blocked = !tr.engaged || tr.pinchFinger !== null;
    if (blocked) tr.motionFloor = t;
    tr.motionProgress = c.motions.map((m) => {
      if (blocked) return { name: m.name, progress: 0 };
      const since = Math.max(tr.motionFloor, tr.motionFired.get(m.name) ?? -Infinity);
      return { name: m.name, progress: motionProgress(tr.samples, m, since) };
    });
    c.motions.forEach((m, i) => {
      if (tr.motionProgress[i]!.progress < 1) return;
      const last = tr.motionFired.get(m.name);
      if (last !== undefined && t - last < (m.cooldownMs ?? DEFAULT_MOTION_COOLDOWN_MS)) return;
      tr.motionFired.set(m.name, t);
      events.push({ type: 'motion', hand: label, name: m.name, t });
    });
  }

  private engage(tr: Track, label: HandLabel, t: number, events: GestureEvent[]): void {
    tr.engaged = true;
    tr.engagedAt = t;
    tr.engageSince = null;
    events.push({ type: 'engage', hand: label, t });
  }

  private checkLost(label: HandLabel, t: number, events: GestureEvent[]): void {
    const tr = this.tracks.get(label);
    if (!tr || t - tr.lastSeen <= this.config.lostAfterMs) return;
    if (tr.pinched && tr.pinchFinger !== null) events.push({ type: 'pinch:end', hand: label, finger: tr.pinchFinger, t });
    if (tr.engaged) events.push({ type: 'disengage', hand: label, t });
    events.push({ type: 'lost', hand: label, t });
    this.tracks.delete(label);
  }
}
