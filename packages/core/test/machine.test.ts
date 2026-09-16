import { describe, expect, it } from 'vitest';
import { GestureCore } from '../src/index.js';
import type { GestureCoreConfigPatch, GestureEvent, Hand, HandLabel, Landmark } from '../src/types.js';
import { hand, loadFixture, translate, withPinchRaw, withThumbDistances } from './helpers.js';

// ── fixtures and script helpers ─────────────────────────────────────────────

const OPEN = loadFixture('open');
const FIST = loadFixture('fist');
const POINT = loadFixture('point');

/** Open palm with the thumb tip placed at an exact pinchRaw. Still scores as openPalm. */
const raw = (r: number) => withPinchRaw(OPEN, r);
const CLOSED = raw(0.1); // below closed + h = 0.20
const RELEASED = raw(0.6); // above closed + 3h = 0.30

/** Smoothing so fast it is a passthrough: state tests assert exact timing, not filter lag. */
const NO_SMOOTHING = { smoothing: { minCutoff: 1e9, beta: 0, dCutoff: 1 } };

/** Pinch-only isolation: always engaged, no poses. */
const PINCH_ONLY: GestureCoreConfigPatch = { ...NO_SMOOTHING, engage: { pose: '' }, poses: [] };

type Frame = [t: number, hands: Hand[]];

const R = (pts: Landmark[], score = 1): Hand => ({ ...hand(pts, 'Right'), score });
const L = (pts: Landmark[], score = 1): Hand => ({ ...hand(pts, 'Left'), score });

function run(core: GestureCore, frames: Frame[]): GestureEvent[] {
  return frames.flatMap(([t, hands]) => core.update(hands, t));
}

/** Frames every `step` ms from `from` to `to` inclusive (to is always included). */
function hold(pts: Landmark[] | null, from: number, to: number, step = 33, label: HandLabel = 'Right'): Frame[] {
  const out: Frame[] = [];
  const make = (t: number): Frame => [t, pts ? [hand(pts, label)] : []];
  for (let t = from; t < to; t += step) out.push(make(t));
  out.push(make(to));
  return out;
}

/** Expected event. Pinch events default to finger 'index'. */
const ev = (type: GestureEvent['type'], t: number, extra: object = {}, h: HandLabel = 'Right') =>
  ({ type, hand: h, t, ...(type.startsWith('pinch') ? { finger: 'index' } : {}), ...extra }) as GestureEvent;

const withoutMoves = (events: GestureEvent[]) => events.filter((e) => e.type !== 'pinch:move');

// ── pinch dwell ─────────────────────────────────────────────────────────────

describe('pinch dwell', () => {
  it('a pinch held for 299 ms emits nothing', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [0, [R(RELEASED)]],
      [100, [R(CLOSED)]],
      [200, [R(CLOSED)]],
      [399, [R(CLOSED)]],
    ]);
    expect(events).toEqual([ev('engage', 0)]);
    expect(core.getHandState('Right')?.pinchProgress).toBeCloseTo(299 / 300, 9);
  });

  it('a pinch held for 301 ms emits pinch:start exactly once', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [0, [R(RELEASED)]],
      [100, [R(CLOSED)]],
      [200, [R(CLOSED)]],
      [399, [R(CLOSED)]],
      [401, [R(CLOSED)]],
    ]);
    expect(events).toEqual([ev('engage', 0), ev('pinch:start', 401)]);
  });

  it('fires at exactly dwellMs (inclusive boundary)', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [100, [R(CLOSED)]],
      [400, [R(CLOSED)]],
    ]);
    expect(events).toEqual([ev('engage', 100), ev('pinch:start', 400)]);
  });

  it('a long hold emits one start, then one move per frame, then one end', () => {
    const core = new GestureCore(PINCH_ONLY);
    const frames = [...hold(CLOSED, 0, 2000), ...hold(RELEASED, 2033, 2100)];
    const events = run(core, frames);
    const types = events.map((e) => e.type);
    expect(types.filter((x) => x === 'pinch:start')).toHaveLength(1);
    expect(types.filter((x) => x === 'pinch:end')).toHaveLength(1);
    const startIdx = types.indexOf('pinch:start');
    const endIdx = types.indexOf('pinch:end');
    expect(types.slice(startIdx + 1, endIdx).every((x) => x === 'pinch:move')).toBe(true);
    // one move for every closed frame after the start frame
    const startT = events[startIdx]!.t;
    expect(endIdx - startIdx - 1).toBe(frames.filter(([t]) => t > startT && t <= 2000).length);
    expect(events[endIdx]).toEqual(ev('pinch:end', 2033));
  });

  it('any frame that breaks the pinch resets the dwell timer to zero', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [0, [R(CLOSED)]],
      [290, [R(CLOSED)]],
      [300, [R(RELEASED)]], // break
      [310, [R(CLOSED)]], // timer restarts here
      [600, [R(CLOSED)]],
      [609, [R(CLOSED)]],
      [610, [R(CLOSED)]],
    ]);
    expect(events).toEqual([ev('engage', 0), ev('pinch:start', 610)]);
  });

  it('wobbling inside the hysteresis band is not a break', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [0, [R(raw(0.19))]],
      [100, [R(raw(0.29))]],
      [200, [R(raw(0.25))]],
      [300, [R(raw(0.3))]],
    ]);
    expect(events).toEqual([ev('engage', 0), ev('pinch:start', 300)]);
  });

  it('pinch:move carries the normalised pinch value', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    const events = run(core, [
      [0, [R(raw(0.15))]],
      [10, [R(raw(0.18))]],
      [20, [R(raw(0.27))]],
    ]);
    expect(events).toEqual([
      ev('engage', 0),
      ev('pinch:start', 0),
      ev('pinch:move', 10, { value: expect.closeTo(0.03 / 0.6, 6) }),
      ev('pinch:move', 20, { value: expect.closeTo(0.12 / 0.6, 6) }),
    ]);
  });
});

// ── hysteresis ──────────────────────────────────────────────────────────────

describe('pinch hysteresis (closed 0.15, h 0.05 → close below 0.20, release above 0.30)', () => {
  const table: { name: string; raws: number[]; expected: string[] }[] = [
    { name: 'exactly 0.20 does not close', raws: [0.5, 0.2, 0.2], expected: [] },
    { name: 'just below 0.20 closes', raws: [0.5, 0.1999], expected: ['start@1'] },
    { name: 'exactly 0.30 does not release', raws: [0.1, 0.3, 0.3], expected: ['start@0', 'move@1', 'move@2'] },
    { name: 'just above 0.30 releases', raws: [0.1, 0.3001], expected: ['start@0', 'end@1'] },
    {
      name: 'chatter across the single 0.20 boundary fires once and never releases',
      raws: [0.19, 0.21, 0.19, 0.21, 0.19, 0.21, 0.19, 0.21],
      expected: ['start@0', 'move@1', 'move@2', 'move@3', 'move@4', 'move@5', 'move@6', 'move@7'],
    },
    {
      name: 'chatter across 0.30 releases once and does not re-close until below 0.20',
      raws: [0.1, 0.31, 0.29, 0.31, 0.29, 0.25, 0.21, 0.19],
      expected: ['start@0', 'end@1', 'start@7'],
    },
    {
      name: 'two clean pinches',
      raws: [0.5, 0.1, 0.1, 0.5, 0.5, 0.1, 0.5],
      expected: ['start@1', 'move@2', 'end@3', 'start@5', 'end@6'],
    },
  ];

  it.each(table)('$name', ({ raws, expected }) => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    const events = raws.flatMap((r, i) => core.update([R(raw(r))], i));
    const got = events
      .filter((e) => e.type.startsWith('pinch'))
      .map((e) => `${e.type.slice(6)}@${e.t}`);
    expect(got).toEqual(expected);
  });

  it('thresholds follow live config', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    expect(core.update([R(raw(0.25))], 0)).toEqual([ev('engage', 0)]);
    core.setConfig({ pinch: { closed: 0.22, hysteresis: 0.05 } }); // close below 0.27
    expect(core.update([R(raw(0.25))], 1)).toEqual([ev('pinch:start', 1)]);
  });
});

// ── which finger ────────────────────────────────────────────────────────────

describe('pinch finger', () => {
  const FAR = { index: 0.9, middle: 0.9, ring: 0.9, pinky: 0.9 };
  const thumbTo = (r: Partial<Record<'index' | 'middle' | 'ring' | 'pinky', number>>) => withThumbDistances(OPEN, { ...FAR, ...r });

  it.each(['index', 'middle', 'ring', 'pinky'] as const)('reports %s on start, move and end', (finger) => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    const events = run(core, [
      [0, [R(thumbTo({ [finger]: 0.1 }))]],
      [10, [R(thumbTo({ [finger]: 0.15 }))]],
      [20, [R(thumbTo({ [finger]: 0.5 }))]],
    ]);
    expect(events).toEqual([
      ev('engage', 0),
      ev('pinch:start', 0, { finger }),
      ev('pinch:move', 10, { finger, value: expect.closeTo(0, 6) }),
      ev('pinch:end', 20, { finger }),
    ]);
    expect(core.getHandState('Right')?.pinchFinger).toBeNull();
  });

  it('only enabled fingers can pinch', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0, pinch: { fingers: ['index'] } });
    expect(run(core, hold(thumbTo({ middle: 0.05 }), 0, 500))).toEqual([ev('engage', 0)]);
  });

  it('during dwell the candidate follows the closest finger without restarting the timer', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [0, [R(thumbTo({ index: 0.12, middle: 0.4 }))]],
      [150, [R(thumbTo({ index: 0.25, middle: 0.08 }))]], // settles on middle; index still within band
      [299, [R(thumbTo({ index: 0.35, middle: 0.08 }))]],
      [300, [R(thumbTo({ index: 0.35, middle: 0.08 }))]],
    ]);
    expect(events).toEqual([ev('engage', 0), ev('pinch:start', 300, { finger: 'middle' })]);
  });

  it('once started the finger is locked; sliding to another finger ends and re-dwells', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [0, [R(thumbTo({ index: 0.1 }))]],
      [300, [R(thumbTo({ index: 0.1 }))]], // start index
      [400, [R(thumbTo({ index: 0.25, middle: 0.05 }))]], // middle is closer but index is still inside the band
      [500, [R(thumbTo({ index: 0.4, middle: 0.05 }))]], // index releases, middle closes: timer restarts
      [799, [R(thumbTo({ index: 0.4, middle: 0.05 }))]],
      [800, [R(thumbTo({ index: 0.4, middle: 0.05 }))]],
    ]);
    expect(events).toEqual([
      ev('engage', 0),
      ev('pinch:start', 300),
      ev('pinch:move', 400, { value: expect.closeTo(0.1 / 0.6, 6) }),
      ev('pinch:end', 500),
      ev('pinch:start', 800, { finger: 'middle' }),
    ]);
  });

  it('disabling the active finger live ends the pinch', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    core.update([R(thumbTo({ ring: 0.1 }))], 0);
    core.setConfig({ pinch: { fingers: ['index', 'middle'] } });
    expect(core.update([R(thumbTo({ ring: 0.1 }))], 10)).toEqual([ev('pinch:end', 10, { finger: 'ring' })]);
  });

  it('a fist does not pinch with any finger', () => {
    const core = new GestureCore(PINCH_ONLY);
    expect(run(core, hold(FIST, 0, 3000))).toEqual([ev('engage', 0)]);
  });
});

// ── poses ───────────────────────────────────────────────────────────────────

describe('pose dwell', () => {
  const POSES_ONLY: GestureCoreConfigPatch = { ...NO_SMOOTHING, engage: { pose: '' } };

  it('fires once after the pose holds for dwellMs, and again only after it changes', () => {
    const core = new GestureCore(POSES_ONLY);
    const events = run(core, [
      ...hold(OPEN, 0, 299, 33),
      [300, [R(OPEN)]],
      ...hold(OPEN, 333, 1000, 33),
      ...hold(FIST, 1033, 1332, 33),
      [1333, [R(FIST)]],
      ...hold(FIST, 1366, 2000, 33),
      ...hold(OPEN, 2033, 2400, 33),
    ]);
    expect(events).toEqual([
      ev('engage', 0),
      ev('pose', 300, { name: 'openPalm' }),
      ev('pose', 1333, { name: 'fist' }),
      ev('pose', 2363, { name: 'openPalm' }), // first 33 ms frame at or after 2033 + 300
    ]);
  });

  it('a single breaking frame resets the pose timer', () => {
    const core = new GestureCore(POSES_ONLY);
    const events = run(core, [
      [0, [R(FIST)]],
      [250, [R(FIST)]],
      [260, [R(POINT)]], // break (and start of a point hold)
      [270, [R(FIST)]], // fist restarts here
      [569, [R(FIST)]],
      [570, [R(FIST)]],
    ]);
    expect(events).toEqual([ev('engage', 0), ev('pose', 570, { name: 'fist' })]);
  });

  it('exposes in-flight progress for a charging ring', () => {
    const core = new GestureCore(POSES_ONLY);
    core.update([R(POINT)], 1000);
    expect(core.getHandState('Right')).toMatchObject({ pose: 'point', poseProgress: 0 });
    core.update([R(POINT)], 1150);
    expect(core.getHandState('Right')?.poseProgress).toBeCloseTo(0.5, 9);
    core.update([R(POINT)], 1400);
    expect(core.getHandState('Right')?.poseProgress).toBe(1);
  });

  it('dwellMs changed mid-hold applies to the hold in flight', () => {
    const core = new GestureCore(POSES_ONLY);
    expect(run(core, [[0, [R(FIST)]], [200, [R(FIST)]]])).toEqual([ev('engage', 0)]);
    core.setConfig({ dwellMs: 150 });
    expect(core.update([R(FIST)], 201)).toEqual([ev('pose', 201, { name: 'fist' })]);
  });

  it('poses can be added at runtime without code', () => {
    const core = new GestureCore({ ...POSES_ONLY, dwellMs: 0 });
    core.setConfig({ poses: [{ name: 'indexOnly', fingers: { index: { curl: [0, 0.2] }, pinky: { curl: [0.7, 1] } } }] });
    expect(core.update([R(POINT)], 0)).toEqual([ev('engage', 0), ev('pose', 0, { name: 'indexOnly' })]);
  });
});

// ── engagement ──────────────────────────────────────────────────────────────

describe('engage', () => {
  const ENGAGE: GestureCoreConfigPatch = { ...NO_SMOOTHING, engage: { pose: 'openPalm', dwellMs: 500 }, poses: undefined };

  it('requires the engage pose to hold for engage.dwellMs', () => {
    const core = new GestureCore(ENGAGE);
    const events = run(core, [...hold(FIST, 0, 1000), ...hold(OPEN, 1033, 1532), [1533, [R(OPEN)]]]);
    expect(events.filter((e) => e.type === 'engage')).toEqual([ev('engage', 1533)]);
  });

  it('breaking the engage pose resets the engage timer', () => {
    const core = new GestureCore(ENGAGE);
    const events = run(core, [
      [0, [R(OPEN)]],
      [400, [R(OPEN)]],
      [450, [R(FIST)]],
      [460, [R(OPEN)]],
      [959, [R(OPEN)]],
      [960, [R(OPEN)]],
    ]);
    expect(events.filter((e) => e.type === 'engage')).toEqual([ev('engage', 960)]);
  });

  it('gates pinch: no pinch events before engaging, and pinch dwell counts from engagement', () => {
    const core = new GestureCore({ ...ENGAGE, poses: [{ name: 'openPalm', fingers: { index: { curl: [0, 0.25] } } }] });
    // pinched from t=0 while holding an open palm: engage at 500, pinch:start at 500 + 300
    const events = run(core, [...hold(CLOSED, 0, 799, 1), [800, [R(CLOSED)]]]);
    expect(withoutMoves(events).filter((e) => e.type !== 'pose')).toEqual([ev('engage', 500), ev('pinch:start', 800)]);
  });

  it('a pinch while not engaged never starts, however long it is held', () => {
    const core = new GestureCore({ ...ENGAGE, engage: { pose: 'fist', dwellMs: 500 } });
    const events = run(core, hold(CLOSED, 0, 5000));
    expect(events.some((e) => e.type.startsWith('pinch') || e.type === 'engage')).toBe(false);
  });

  it('stays engaged through other poses; only loss disengages', () => {
    const core = new GestureCore(ENGAGE);
    const events = run(core, [...hold(OPEN, 0, 600), ...hold(FIST, 633, 3000), ...hold(null, 3033, 3500)]);
    expect(events.filter((e) => e.type === 'engage' || e.type === 'disengage' || e.type === 'lost')).toEqual([
      ev('engage', 528), // first 33 ms frame at or after 500
      ev('disengage', 3165), // last seen 3000, first frame more than 150 ms later
      ev('lost', 3165),
    ]);
  });

  it('an engage pose missing from poses never engages', () => {
    const core = new GestureCore({ ...ENGAGE, engage: { pose: 'nonexistent', dwellMs: 0 } });
    expect(run(core, hold(OPEN, 0, 2000)).some((e) => e.type === 'engage')).toBe(false);
  });

  it('exposes engage progress', () => {
    const core = new GestureCore(ENGAGE);
    core.update([R(OPEN)], 0);
    core.update([R(OPEN)], 250);
    expect(core.getHandState('Right')?.engageProgress).toBeCloseTo(0.5, 9);
    core.update([R(OPEN)], 500);
    expect(core.getHandState('Right')).toMatchObject({ engaged: true, engageProgress: 1 });
  });
});

// ── loss ────────────────────────────────────────────────────────────────────

describe('loss', () => {
  it('emits lost only once absence exceeds lostAfterMs (strictly greater)', () => {
    const core = new GestureCore(PINCH_ONLY);
    const events = run(core, [
      [1000, [R(OPEN)]],
      [1100, []],
      [1150, []],
      [1151, []],
      [1200, []],
    ]);
    expect(events).toEqual([ev('engage', 1000), ev('disengage', 1151), ev('lost', 1151)]);
    expect(core.getFeatures('Right')).toBeNull();
    expect(core.getHandState('Right')).toBeNull();
  });

  it('closes an active pinch and engagement before lost, in order', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    const events = run(core, [
      [0, [R(CLOSED)]],
      [33, [R(CLOSED)]],
      [200, []],
    ]);
    expect(events).toEqual([
      ev('engage', 0),
      ev('pinch:start', 0),
      ev('pinch:move', 33, { value: 0 }),
      ev('pinch:end', 200),
      ev('disengage', 200),
      ev('lost', 200),
    ]);
  });

  it('brief occlusion keeps a drag alive', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    const events = run(core, [
      [0, [R(CLOSED)]],
      [50, []],
      [100, []],
      [150, []],
      [183, [R(CLOSED)]], // loss is only checked on hand-less frames; the last one (150) was exactly at the limit
    ]);
    expect(withoutMoves(events)).toEqual([ev('engage', 0), ev('pinch:start', 0)]);
    expect(events.at(-1)).toEqual(ev('pinch:move', 183, { value: 0 }));
  });

  it('a hand that returns after loss starts from scratch', () => {
    const core = new GestureCore({ ...NO_SMOOTHING, engage: { pose: 'openPalm', dwellMs: 100 } });
    const events = run(core, [
      [0, [R(OPEN)]],
      [100, [R(OPEN)]],
      [400, []],
      [500, [R(OPEN)]],
      [599, [R(OPEN)]],
      [600, [R(OPEN)]],
    ]);
    expect(events.filter((e) => e.type !== 'pose')).toEqual([
      ev('engage', 100),
      ev('disengage', 400),
      ev('lost', 400),
      ev('engage', 600),
    ]);
  });

  it('updating with no hands and nothing tracked is a no-op', () => {
    const core = new GestureCore();
    expect(core.update([], 0)).toEqual([]);
    expect(core.update([], 10_000)).toEqual([]);
  });
});

// ── two hands and input hygiene ─────────────────────────────────────────────

describe('multiple hands', () => {
  it('tracks hands independently and orders each frame Left before Right', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    const events = run(core, [
      [0, [R(CLOSED), L(RELEASED)]],
      [10, [R(RELEASED), L(CLOSED)]],
      [20, [R(RELEASED)]],
      [200, [R(RELEASED)]],
    ]);
    expect(events).toEqual([
      ev('engage', 0, {}, 'Left'),
      ev('engage', 0),
      ev('pinch:start', 0),
      ev('pinch:start', 10, {}, 'Left'),
      ev('pinch:end', 10),
      ev('pinch:end', 200, {}, 'Left'),
      ev('disengage', 200, {}, 'Left'),
      ev('lost', 200, {}, 'Left'),
    ]);
  });

  it('when two hands claim the same label, the higher score wins', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    core.update([R(RELEASED, 0.6), R(CLOSED, 0.9)], 0);
    expect(core.getHandState('Right')?.pinched).toBe(true);
    expect(core.getHandState('Left')).toBeNull();
  });

  it('ignores malformed hands as if absent', () => {
    const core = new GestureCore(PINCH_ONLY);
    const nan = OPEN.map((p, i) => (i === 3 ? { ...p, x: Number.NaN } : p));
    expect(core.update([R(OPEN.slice(0, 20)), R(nan), { ...R(OPEN), handedness: 'Up' as HandLabel }], 0)).toEqual([]);
    expect(core.getFeatures('Right')).toBeNull();
  });

  it('does not mutate the hands passed in', () => {
    const core = new GestureCore();
    const input = [R(OPEN), L(FIST)];
    const snap = JSON.stringify(input);
    run(core, hold(OPEN, 0, 500).map(([t]) => [t, input] as Frame));
    expect(JSON.stringify(input)).toBe(snap);
  });
});

// ── smoothing, config, reset, determinism ───────────────────────────────────

describe('pipeline', () => {
  it('smooths landmarks before extracting features', () => {
    const core = new GestureCore({ engage: { pose: '' }, dwellMs: 0 });
    core.update([R(RELEASED)], 0);
    core.update([R(CLOSED)], 33);
    const f = core.getFeatures('Right')!;
    expect(f.pinchRaw).toBeGreaterThan(0.3); // default One Euro has not caught up in one frame
    expect(core.getHandState('Right')?.pinchClosed).toBe(false);
  });

  it('getFeatures returns the latest frame for that hand only', () => {
    const core = new GestureCore(NO_SMOOTHING);
    core.update([R(translate(OPEN, 0.1, 0)), L(FIST)], 0);
    expect(core.getFeatures('Right')!.openness).toBeGreaterThan(0.85);
    expect(core.getFeatures('Left')!.openness).toBeLessThan(0.2);
  });

  it('setConfig updates smoothing on live hands without resetting them', () => {
    const core = new GestureCore({ engage: { pose: '' } });
    core.update([R(RELEASED)], 0);
    core.setConfig(NO_SMOOTHING);
    core.update([R(CLOSED)], 33);
    expect(core.getFeatures('Right')!.pinchRaw).toBeCloseTo(0.1, 6);
    expect(core.getHandState('Right')?.engaged).toBe(true);
  });

  it('getConfig round-trips through JSON and setConfig', () => {
    const a = new GestureCore({ dwellMs: 420, pinch: { closed: 0.12 } });
    const json = JSON.stringify(a.getConfig());
    const b = new GestureCore(JSON.parse(json));
    expect(b.getConfig()).toEqual(a.getConfig());
    const cfg = a.getConfig();
    cfg.dwellMs = 1;
    expect(a.getConfig().dwellMs).toBe(420);
  });

  it('reset forgets every hand and emits nothing', () => {
    const core = new GestureCore({ ...PINCH_ONLY, dwellMs: 0 });
    core.update([R(CLOSED), L(CLOSED)], 0);
    core.reset();
    expect(core.getFeatures('Right')).toBeNull();
    expect(core.update([], 1000)).toEqual([]);
    expect(core.update([R(CLOSED)], 1001)).toEqual([ev('engage', 1001), ev('pinch:start', 1001)]);
  });

  it('is deterministic: the same script gives the same events', () => {
    const script: Frame[] = [];
    const seq = [OPEN, OPEN, CLOSED, CLOSED, FIST, POINT, RELEASED];
    for (let i = 0; i < 400; i++) {
      const t = i * 17 + (i % 7);
      script.push([t, i % 53 > 48 ? [] : [R(seq[Math.floor(i / 11) % seq.length]!), L(seq[(i >> 3) % seq.length]!)]]);
    }
    const a = run(new GestureCore(), script);
    const b = run(new GestureCore(), script);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it('every start is paired with an end and every engage with a disengage before lost', () => {
    const script: Frame[] = [];
    const seq = [OPEN, CLOSED, CLOSED, CLOSED, RELEASED, FIST];
    for (let i = 0; i < 1500; i++) {
      const gone = i % 97 > 80;
      script.push([i * 20, gone ? [] : [R(seq[Math.floor(i / 9) % seq.length]!)]]);
    }
    script.push([1e9, []]);
    const events = run(new GestureCore({ ...NO_SMOOTHING, engage: { pose: 'openPalm', dwellMs: 100 } }), script);
    let pinched = false;
    let engaged = false;
    for (const e of events) {
      if (e.type === 'pinch:start') { expect(pinched).toBe(false); pinched = true; }
      if (e.type === 'pinch:move') expect(pinched).toBe(true);
      if (e.type === 'pinch:end') { expect(pinched).toBe(true); pinched = false; }
      if (e.type === 'engage') { expect(engaged).toBe(false); engaged = true; }
      if (e.type === 'disengage') { expect(pinched).toBe(false); engaged = false; }
      if (e.type === 'lost') { expect(pinched).toBe(false); expect(engaged).toBe(false); }
    }
    expect(events.filter((e) => e.type === 'pinch:start').length).toBeGreaterThan(3);
    expect(events.filter((e) => e.type === 'lost').length).toBeGreaterThan(3);
  });
});
