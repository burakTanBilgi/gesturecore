import type { FingerName, PoseDescription } from '../types.js';

/**
 * Reads poses out of data this library did not write — a file someone shared, a paste,
 * an upload — and returns only what is unmistakably a pose.
 *
 * The rule the whole thing rests on: **a pose is declarative data and never code.** It
 * is a name and some number ranges. Nothing here is ever evaluated, no key is ever
 * copied across without being named first, and nothing is merged into an existing
 * object. That is what makes installing someone else's pose safe in a way that
 * installing someone else's plugin is not, and it must never be relaxed for
 * convenience: the moment a pose can carry behaviour, this argument is gone.
 *
 * So it is a whitelist, not a filter. Every key is named here or the pose is refused,
 * which means a file that grows a field this version does not know is rejected loudly
 * rather than accepted with a surprise in it.
 */

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/**
 * Letters, digits and marks in any script, plus space, dash and underscore. Enough to
 * name a pose in the language you think in — `üç`, `три`, `三` — and not enough to be
 * markup, a selector, or a line of anything. Quotes, angle brackets, control characters
 * and newlines are all outside it.
 */
const NAME = /^[\p{L}\p{N}\p{M} _-]{1,40}$/u;

/** An ISO 8601 date or instant, and one a calendar agrees with — not just one shaped right. */
function isDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/.test(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

/** More than anyone will actually read through before installing, which is the point. */
const MAX_POSES = 64;

/** Keys that mean something to JavaScript rather than to us. Never allowed, anywhere. */
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

/** A plain JSON object: not null, not an array, and not something exotic. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Own keys including `__proto__`, which `Object.keys` reports but `in` and dotted access
 * do not reach on a JSON-parsed object. Anything unexpected is the caller's problem.
 */
function keysOf(o: Record<string, unknown>): string[] {
  return Object.getOwnPropertyNames(o);
}

function isNum(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function readCurl(v: unknown): [number, number] | string {
  if (!Array.isArray(v)) return 'curl must be a two-number array';
  if (v.length !== 2) return `curl must have 2 numbers, got ${v.length}`;
  const [lo, hi] = v as unknown[];
  if (!isNum(lo, 0, 1) || !isNum(hi, 0, 1)) return 'curl values must be numbers in 0..1';
  if (lo > hi) return `curl range is backwards: [${lo}, ${hi}]`;
  return [lo, hi];
}

/** One pose, or why it was refused. Builds a new object; never reuses the input's. */
function readPose(v: unknown, where: string): PoseDescription | string {
  if (!isPlainObject(v)) return `${where}: not an object`;

  const keys = keysOf(v);
  for (const k of keys) {
    if (DANGEROUS.has(k)) return `${where}: refusing the key "${k}"`;
    if (k !== 'name' && k !== 'fingers' && k !== 'minScore' && k !== 'enabled' && k !== 'addedAt') {
      return `${where}: unknown key "${k}"`;
    }
  }

  const name: unknown = v['name'];
  if (typeof name !== 'string' || !NAME.test(name)) {
    return `${where}: a name must be 1-40 characters of letters, digits, spaces, "-" or "_"`;
  }

  const rawFingers: unknown = v['fingers'];
  if (!isPlainObject(rawFingers)) return `${name}: "fingers" must be an object`;

  const fingers: PoseDescription['fingers'] = {};
  for (const finger of keysOf(rawFingers)) {
    if (DANGEROUS.has(finger)) return `${name}: refusing the finger key "${finger}"`;
    if (!(FINGERS as readonly string[]).includes(finger)) return `${name}: "${finger}" is not a finger`;

    const spec: unknown = rawFingers[finger];
    if (!isPlainObject(spec)) return `${name}.${finger}: must be an object`;
    for (const k of keysOf(spec)) {
      if (k !== 'curl') return `${name}.${finger}: unknown key "${k}"`;
    }
    if (!('curl' in spec)) {
      fingers[finger as FingerName] = {};
      continue;
    }
    const curl = readCurl(spec['curl']);
    if (typeof curl === 'string') return `${name}.${finger}: ${curl}`;
    fingers[finger as FingerName] = { curl };
  }

  const pose: PoseDescription = { name, fingers };

  if ('minScore' in v) {
    const minScore: unknown = v['minScore'];
    if (!isNum(minScore, 0, 1)) return `${name}: "minScore" must be a number in 0..1`;
    pose.minScore = minScore;
  }
  if ('enabled' in v) {
    const enabled: unknown = v['enabled'];
    if (typeof enabled !== 'boolean') return `${name}: "enabled" must be true or false`;
    pose.enabled = enabled;
  }
  if ('addedAt' in v) {
    const addedAt: unknown = v['addedAt'];
    if (!isDate(addedAt)) return `${name}: "addedAt" must be an ISO 8601 date, like 2026-09-27`;
    pose.addedAt = addedAt;
  }
  return pose;
}

export type ParsedPoses = {
  /** Every pose that was unmistakably one. Safe to put straight into the config. */
  poses: PoseDescription[];
  /** One line per pose refused, in the order they appeared. Show these to the person. */
  problems: string[];
};

/**
 * Parse poses from untrusted data. Never throws: bad input comes back as `problems`,
 * because the caller is going to show this to someone rather than catch it.
 *
 * A file that is wrong as a whole (not an array, too many poses, duplicate names) yields
 * no poses at all — that is a broken file, not a file with a bad pose in it. A file whose
 * individual poses disagree yields the good ones and a line about each bad one, so one
 * typo does not cost you the other twenty.
 */
export function parsePoses(input: unknown): ParsedPoses {
  if (!Array.isArray(input)) return { poses: [], problems: ['expected a JSON array of poses'] };
  if (input.length > MAX_POSES) {
    return { poses: [], problems: [`${input.length} poses is more than the ${MAX_POSES} allowed in one file`] };
  }

  const poses: PoseDescription[] = [];
  const problems: string[] = [];
  for (const [i, entry] of input.entries()) {
    const pose = readPose(entry, `pose ${i + 1}`);
    if (typeof pose === 'string') problems.push(pose);
    else poses.push(pose);
  }

  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const p of poses) {
    if (seen.has(p.name)) repeated.add(p.name);
    seen.add(p.name);
  }
  if (repeated.size > 0) {
    return { poses: [], problems: [`the same name appears more than once: ${[...repeated].join(', ')}`] };
  }

  return { poses, problems };
}
