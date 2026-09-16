/**
 * Decides what should sound, without making any sound.
 *
 * Pure: gesture events and hand readings in, a list of plain actions out. The Web
 * Audio side (engine.ts) only carries those actions out, so everything musical here
 * is testable in Node.
 */
import type { Features, GestureEvent, HandLabel } from 'gesturecore';
import { midiToHz, snapToScale, toMidi } from './notes.js';
import type { ControlDescription, ControlSource, CueDescription, ReadHand, SoundAction, SoundConfig, SoundName } from './types.js';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The note each sound plays when a cue does not name one. */
const DEFAULT_NOTE: Record<SoundName, number> = {
  click: 96,
  blip: 76,
  chime: 72,
  pluck: 64,
  swoosh: 60,
  thud: 43,
  rise: 67,
  fall: 67,
};

/** A hand measurement as 0..1. */
export function readSource(f: Features, source: ControlSource): number {
  switch (source) {
    case 'x':
      return clamp01(f.centroid.x);
    case 'y':
      return clamp01(f.centroid.y);
    case 'pinch':
      return clamp01(f.pinch);
    case 'openness':
      return clamp01(f.openness);
    case 'tilt':
      // ±90° covers every comfortable wrist turn
      return clamp01((f.tilt + Math.PI / 2) / Math.PI);
    case 'span':
      // roughly arm's length (0.1) to close to the camera (0.5)
      return clamp01((f.span - 0.1) / 0.4);
  }
}

const panOf = (f: Features | null) => (f ? clamp01(f.centroid.x) * 2 - 1 : 0);

function cueMatches(cue: CueDescription, e: GestureEvent): boolean {
  if (cue.on !== e.type) return false;
  if (cue.hand !== undefined && cue.hand !== e.hand) return false;
  if (cue.name !== undefined && !('name' in e && e.name === cue.name)) return false;
  if (cue.finger !== undefined && !('finger' in e && e.finger === cue.finger)) return false;
  return true;
}

/** One-shot sounds for this frame's events, in event order. */
export function planCues(cues: readonly CueDescription[], events: readonly GestureEvent[], read: ReadHand): SoundAction[] {
  const out: SoundAction[] = [];
  for (const e of events) {
    for (const cue of cues) {
      if (!cueMatches(cue, e)) continue;
      const pan = cue.pan === 'hand' ? panOf(read(e.hand).features) : Math.max(-1, Math.min(1, cue.pan ?? 0));
      out.push({
        kind: 'play',
        sound: cue.sound,
        frequency: midiToHz(cue.note === undefined ? DEFAULT_NOTE[cue.sound] : toMidi(cue.note)),
        gain: clamp01(cue.gain ?? 0.5),
        pan,
      });
    }
  }
  return out;
}

function conditionHolds(c: ControlDescription, read: ReadHand): boolean {
  const { features, state } = read(c.hand);
  if (!features || !state) return false;
  switch (c.while ?? 'engaged') {
    case 'always':
      return true;
    case 'engaged':
      return state.engaged;
    case 'pinched':
      return state.pinched;
  }
}

/**
 * The state of every sustained voice this frame. A voice sounds while any of its
 * controls' conditions hold; each control sets the parameter it targets, and a
 * parameter nobody controls keeps a sensible default.
 */
export function planVoices(controls: readonly ControlDescription[], read: ReadHand): SoundAction[] {
  const byVoice = new Map<string, ControlDescription[]>();
  for (const c of controls) byVoice.set(c.voice, [...(byVoice.get(c.voice) ?? []), c]);

  const out: SoundAction[] = [];
  for (const [voice, list] of byVoice) {
    const first = list[0]!;
    let on = false;
    let frequency = midiToHz(toMidi(first.root ?? 'C4'));
    let gain = 0.4;
    let brightness = 2400;
    let pan = 0;
    for (const c of list) {
      if (!conditionHolds(c, read)) continue;
      on = true;
      const f = read(c.hand).features!;
      pan = panOf(f);
      let v = readSource(f, c.source);
      if (c.invert) v = 1 - v;
      const value = c.range[0] + (c.range[1] - c.range[0]) * v;
      if (c.target === 'pitch') {
        const midi = snapToScale(value, c.scale ?? 'pentatonic', toMidi(c.root ?? 'C4'));
        frequency = midiToHz(midi);
      } else if (c.target === 'volume') {
        gain = clamp01(value);
      } else {
        brightness = Math.max(40, value);
      }
    }
    out.push({ kind: 'voice', voice, on, waveform: first.waveform ?? 'triangle', frequency, gain, brightness, pan });
  }
  return out;
}

/** Everything that should happen this frame: one-shots first, then voices. */
export function planSound(config: SoundConfig, events: readonly GestureEvent[], read: ReadHand): SoundAction[] {
  return [...planCues(config.cues, events, read), ...planVoices(config.controls, read)];
}

/**
 * Every hand, as the planner needs it, read live from a GestureCore. Safe to create
 * once and reuse: each call reads the core's current state.
 */
export function readerFor(core: {
  getFeatures(hand: HandLabel): Features | null;
  getHandState(hand: HandLabel): ReturnType<ReadHand>['state'];
}): ReadHand {
  return (hand) => ({ features: core.getFeatures(hand), state: core.getHandState(hand) });
}
