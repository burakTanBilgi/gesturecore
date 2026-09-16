import type { Features, GestureEventType, HandLabel, HandState, PinchFinger } from 'gesturecore';

/** Built-in synthesized sounds. No audio files: every one is made from oscillators and noise. */
export type SoundName = 'click' | 'blip' | 'chime' | 'pluck' | 'swoosh' | 'thud' | 'rise' | 'fall';

/** A note as a MIDI number (60 = middle C) or a name such as "C5", "F#4", "Bb3". */
export type Note = number | string;

/**
 * A one-shot sound fired by a gesture event. Every field but `on` and `sound` narrows
 * which events match.
 */
export type CueDescription = {
  on: GestureEventType;
  sound: SoundName;
  /** Only this hand. */
  hand?: HandLabel;
  /** For `pose` and `motion` events: only this pose or movement. */
  name?: string;
  /** For pinch events: only this finger. */
  finger?: PinchFinger;
  note?: Note;
  /** 0..1, before the master volume. */
  gain?: number;
  /** -1 left … 1 right, or "hand" to follow the palm across the frame. */
  pan?: number | 'hand';
};

/** A hand measurement a control can follow, each normalised to 0..1. */
export type ControlSource = 'x' | 'y' | 'pinch' | 'openness' | 'tilt' | 'span';

export type ControlTarget = 'pitch' | 'volume' | 'brightness';

export type Scale = 'none' | 'chromatic' | 'major' | 'minor' | 'pentatonic';

export type Waveform = 'sine' | 'triangle' | 'sawtooth' | 'square';

/**
 * A continuous control: while its condition holds, a hand measurement steers one
 * parameter of a sustained voice. Controls sharing a `voice` name steer the same
 * voice — pitch from one measurement, volume from another.
 */
export type ControlDescription = {
  voice: string;
  hand: HandLabel;
  source: ControlSource;
  target: ControlTarget;
  /** Output range: MIDI notes for pitch, 0..1 for volume, Hz for brightness. */
  range: [number, number];
  /** Flip the source, e.g. so raising the hand (smaller y) raises the pitch. */
  invert?: boolean;
  /** When the voice sounds. Default "engaged". */
  while?: 'always' | 'engaged' | 'pinched';
  waveform?: Waveform;
  /** Pitch only: snap to a scale. Default "pentatonic", which is hard to make sound wrong. */
  scale?: Scale;
  /** Pitch only: the scale's root note. Default C. */
  root?: Note;
};

export type SoundConfig = {
  /** Master volume, 0..1. */
  volume: number;
  cues: CueDescription[];
  controls: ControlDescription[];
};

export type SoundConfigPatch = Partial<SoundConfig>;

/** What the planner needs to know about one hand. */
export type HandReading = { features: Features | null; state: HandState | null };

export type ReadHand = (hand: HandLabel) => HandReading;

/** One thing the audio side should do. Plain data, so plans are testable without sound. */
export type SoundAction =
  | { kind: 'play'; sound: SoundName; frequency: number; gain: number; pan: number }
  | {
      kind: 'voice';
      voice: string;
      on: boolean;
      waveform: Waveform;
      frequency: number;
      gain: number;
      brightness: number;
      pan: number;
    };
