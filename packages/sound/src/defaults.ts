import type { ControlDescription, CueDescription, SoundConfig } from './types.js';

/** Quiet, short confirmations for the core's default gestures. */
export const DEFAULT_CUES: CueDescription[] = [
  { on: 'engage', sound: 'rise', note: 'G4', gain: 0.25 },
  { on: 'disengage', sound: 'fall', note: 'G4', gain: 0.2 },
  { on: 'pinch:start', finger: 'index', sound: 'blip', note: 'E5', gain: 0.35, pan: 'hand' },
  { on: 'pinch:start', finger: 'middle', sound: 'blip', note: 'G5', gain: 0.35, pan: 'hand' },
  { on: 'pinch:start', finger: 'ring', sound: 'blip', note: 'A5', gain: 0.35, pan: 'hand' },
  { on: 'pinch:start', finger: 'pinky', sound: 'blip', note: 'C6', gain: 0.35, pan: 'hand' },
  { on: 'pinch:end', sound: 'click', gain: 0.2, pan: 'hand' },
  { on: 'pose', sound: 'chime', note: 'C5', gain: 0.3 },
  { on: 'motion', name: 'swipeLeft', sound: 'swoosh', gain: 0.4, pan: -0.6 },
  { on: 'motion', name: 'swipeRight', sound: 'swoosh', gain: 0.4, pan: 0.6 },
  { on: 'motion', name: 'wave', sound: 'chime', note: 'G5', gain: 0.35, pan: 'hand' },
];

/**
 * A pinch-to-play theremin: pinch with the right hand, raise it to go up the scale,
 * open the other fingers wider to play louder, move sideways to brighten the tone.
 */
export const THEREMIN: ControlDescription[] = [
  { voice: 'theremin', hand: 'Right', while: 'pinched', source: 'y', invert: true, target: 'pitch', range: [55, 84], scale: 'pentatonic', root: 'C4', waveform: 'triangle' },
  { voice: 'theremin', hand: 'Right', while: 'pinched', source: 'openness', target: 'volume', range: [0.15, 0.6] },
  { voice: 'theremin', hand: 'Right', while: 'pinched', source: 'x', target: 'brightness', range: [600, 6000] },
];

export function defaultSoundConfig(): SoundConfig {
  return { volume: 0.7, cues: JSON.parse(JSON.stringify(DEFAULT_CUES)) as CueDescription[], controls: [] };
}
