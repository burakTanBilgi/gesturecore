# gesturecore-sound

**Sound for [gesturecore](../core), as an optional brick.** Gesture events trigger short
synthesized cues, and hand measurements can steer sustained voices — a pinch-to-play
theremin is built in. No audio files: every sound is made from oscillators and noise.

The core does not know this package exists, and this package depends on the core's
*types* only.

```ts
import { GestureCore } from 'gesturecore';
import { GestureSound, THEREMIN, readerFor } from 'gesturecore-sound';

const core = new GestureCore({ aspect: 640 / 480 });
const sound = new GestureSound({ controls: THEREMIN });

button.onclick = () => sound.start();   // browsers only allow audio after a user action

function frame(hands, t) {
  const events = core.update(hands, t);
  sound.update(events, readerFor(core));
}
```

## Cues — one-shot sounds for events

```ts
{ on: 'pinch:start', finger: 'index', sound: 'blip', note: 'E5', gain: 0.35, pan: 'hand' }
{ on: 'motion', name: 'swipeLeft', sound: 'swoosh', pan: -0.6 }
```

| field | meaning |
| --- | --- |
| `on` | any gesturecore event type: `engage`, `pinch:start`, `pose`, `motion`, … |
| `sound` | `click` `blip` `chime` `pluck` `swoosh` `thud` `rise` `fall` |
| `hand`, `name`, `finger` | optional filters: only this hand, pose/movement name, or pinch finger |
| `note` | MIDI number or a name like `"C5"`, `"F#4"`, `"Bb3"` |
| `gain` | 0..1 before the master volume |
| `pan` | -1 left … 1 right, or `"hand"` to follow the palm |

The defaults give each built-in gesture a quiet confirmation.

## Controls — hands steering a voice

A control maps one hand measurement (`x`, `y`, `pinch`, `openness`, `tilt`, `span`,
each 0..1) onto one voice parameter (`pitch`, `volume`, `brightness`) while a condition
holds (`always`, `engaged`, `pinched`). Controls with the same `voice` name steer the
same voice.

```ts
// raise the pinched right hand to go up a pentatonic scale
{ voice: 'theremin', hand: 'Right', while: 'pinched', source: 'y', invert: true,
  target: 'pitch', range: [55, 84], scale: 'pentatonic', root: 'C4' }
```

Pitch snaps to `pentatonic` by default — it is hard to make sound wrong. Use `none`
for a continuous slide.

## How it is built

- **`plan.ts`** decides what should sound: events and hand readings in, plain actions
  out. Pure, and tested in Node without any audio.
- **`engine.ts`** plays those actions with the Web Audio API. It is the only file that
  touches the browser; a test enforces that.

So the musical decisions are testable, and another audio backend could replace the
engine without touching them.

## API

| member | purpose |
| --- | --- |
| `new GestureSound(config?, engine?)` | the convenient front door |
| `start()` / `stop()` | open or release the audio device |
| `update(events, read)` | plan this frame and play it |
| `getConfig()` / `setConfig(patch)` | `volume`, `cues`, `controls` |
| `readerFor(core)` | adapt a `GestureCore` into the hand reader `update` wants |
| `planSound`, `planCues`, `planVoices` | the pure planner, for custom engines |
| `toMidi`, `midiToHz`, `snapToScale` | note helpers |
| `DEFAULT_CUES`, `THEREMIN`, `defaultSoundConfig()` | presets |

MIT.
