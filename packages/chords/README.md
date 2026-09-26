# gesturecore-chords

**Two hands, one chord: the note hand counts the scale on its fingers, the other
hand decides major or minor.**

An optional brick. It reads the poses and pinches the core already reports and turns
them into chord names — it adds no geometry of its own, touches no audio, and the
core never knows it exists.

```ts
import { ChordReader, readerFor } from 'gesturecore-chords';

const chords = new ChordReader();

core.update(hands, t);
for (const e of chords.update(readerFor(core), t)) {
  if (e.type === 'chord:start') console.log(e.chord.name, e.chord.notes); // "Am" [69, 72, 76]
}
```

`readerFor` is just `(hand) => ({ features, state })`, read live from the core each call.
Write your own if your hands come from somewhere else — that is the only seam this brick
has, and it is why nothing here imports the sound brick.

## The two decisions

A chord is a note and a quality, so each gets its own hand. They never share a shape.

**The note hand** counts: one finger is A, and every finger after it steps up the
scale. That covers A–E and runs out, so the last two reuse shapes the core already
knows — F is the closed fist, G is a pinch.

| letter | shape | |
| --- | --- | --- |
| A | `point` | 1 finger |
| B | `peace` | 2 fingers |
| C | `three` | 3 fingers |
| D | `four` | 4 fingers |
| E | `openPalm` | 5 fingers |
| F | `fist` | nothing extended |
| G | pinch `index` | |

`peace`, `three` and `four` are not core defaults. Record them with the bench's pose
recorder, or point the config at whatever you name them.

**The other hand** carries quality: pinch the middle finger and the chord is minor.
Anything else is major.

## Sharps and flats

Tilt the note hand. It is already measured per hand and nothing else uses it.

Tilt is continuous, so one threshold would flap while a hand rests near it. There are
two: it takes `enterDeg` to pick an accidental up and coming back inside `exitDeg` to
put it down, and in between whatever is held stays held.

```ts
new ChordReader({ accidental: { source: 'none', enterDeg: 20, exitDeg: 12, invert: false } });
```

## When a chord sounds

Three triggers, all worth trying with a real hand:

| `trigger` | |
| --- | --- |
| `engage` | one shot the moment a chord is taken up. Percussive, never sustained. |
| `sustain` | rings while the shape is held, stops when it is let go. The default. |
| `latch` | rings until a different chord replaces it, ignoring the hands leaving. |

Tracking drops for a frame or two constantly, and under `sustain` every drop would cut
the chord off. `releaseGraceMs` (default 120) is how long a held chord survives the
hands vanishing.

## Config

Nothing is hardcoded — every shape, both hands' jobs, and all the timing are config.
`setConfig` takes a patch and applies it live, so a panel can change any of it between
frames.

```ts
const chords = new ChordReader({ noteHand: 'Left' });   // swaps both jobs at once
chords.setConfig({ trigger: 'latch', octave: 3 });
```

| | | default |
| --- | --- | --- |
| `noteHand` | which hand picks the letter; the other gets quality | `'Right'` |
| `letters` | letter → shape | the table above |
| `minor` | the shape that makes a chord minor | pinch `middle` |
| `accidental` | `source`, `enterDeg`, `exitDeg`, `invert` | tilt, 20°, 12° |
| `octave` | octave of the root; 4 puts A at MIDI 69 | `4` |
| `trigger` | `engage`, `sustain` or `latch` | `'sustain'` |
| `releaseGraceMs` | how long a chord outlives the hands under `sustain` | `120` |

## Events

```ts
type ChordEvent =
  | { type: 'chord:start'; chord: Chord; t: number }
  | { type: 'chord:end';   chord: Chord; t: number };

type Chord = {
  letter: string;          // as written in the config
  accidental: -1 | 0 | 1;  // flat, natural, sharp
  quality: 'major' | 'minor';
  name: string;            // "A", "Am", "A#", "Abm"
  notes: number[];         // MIDI, root first
};
```

`chords.current` is the chord sounding right now, or null. `reset()` forgets it
without emitting anything.

Under `engage` only `chord:start` ever fires — it is a one-shot, so there is nothing
to end.

## Drawing the whole scheme

`chordStatus` is a snapshot for a UI: every letter at once, with whether it is held
and whether it is reachable at all.

```ts
const status = chordStatus(config, read, core.getConfig().poses.map((p) => p.name));
// letters: [{ letter: 'A', shape, held: false, missing: false }, …]
// quality, accidental, chord
```

`missing` is the useful one. A letter naming a pose the core has not been given can
never fire, so a fresh bench reports B, C and D missing until the counting poses are
recorded — better shown greyed out than silently dead.

## Licence

MIT — see [LICENSE](LICENSE).
