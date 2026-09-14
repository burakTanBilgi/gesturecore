import { DEFAULT_POSES } from './poses/defaults.js';
import type { GestureCoreConfig, GestureCoreConfigPatch } from './types.js';

/** Plain JSON copy. Config is flat data by contract, so this is lossless. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export const DEFAULT_CONFIG: Readonly<GestureCoreConfig> = Object.freeze({
  // One Euro, t in seconds, values in normalised landmark units.
  smoothing: { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 },
  pinch: { closed: 0.15, open: 0.75, hysteresis: 0.05 },
  engage: { pose: 'openPalm', dwellMs: 500 },
  dwellMs: 300,
  lostAfterMs: 150,
  poses: copy(DEFAULT_POSES) as GestureCoreConfig['poses'],
  curl: { straight: 0.25, bent: 2.4, thumbStraight: 0.2, thumbBent: 1.4 },
  poseFalloff: 0.15,
  aspect: 1,
});

export function defaultConfig(): GestureCoreConfig {
  return copy(DEFAULT_CONFIG);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns a new config: `base` with `patch` applied. Sections merge one level deep,
 * arrays (poses) replace wholesale, unknown keys and mistyped values are ignored.
 * Neither input is mutated.
 */
export function mergeConfig(base: GestureCoreConfig, patch: GestureCoreConfigPatch | undefined): GestureCoreConfig {
  const out = copy(base) as unknown as Record<string, unknown>;
  if (!patch) return out as unknown as GestureCoreConfig;
  const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in defaults)) continue;
    const ref = defaults[key];
    if (Array.isArray(ref)) {
      if (Array.isArray(value)) out[key] = copy(value);
    } else if (isPlainObject(ref)) {
      if (!isPlainObject(value)) continue;
      const section = out[key] as Record<string, unknown>;
      for (const [k, v] of Object.entries(value)) {
        if (k in ref && typeof v === typeof ref[k] && (typeof v !== 'number' || Number.isFinite(v))) {
          section[k] = v;
        }
      }
    } else if (typeof value === typeof ref && (typeof value !== 'number' || Number.isFinite(value))) {
      out[key] = value;
    }
  }
  return out as unknown as GestureCoreConfig;
}
