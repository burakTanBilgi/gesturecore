# gesturecore

Turns MediaPipe hand landmarks into clean, debounced gesture events. Framework-agnostic
TypeScript with no runtime dependencies. It is the middle layer between a landmark
source (MediaPipe Tasks Vision) and thin per-project adapters.

```
Source    camera → MediaPipe Tasks Vision → 21 landmarks/hand
            ↓
Core      features → state+time → events          ← this package (src/)
            ↓
Adapters  browser | instrument | OSC/MIDI         ← thin, per-project (bench/ is the first)
```

## Use

```ts
import { GestureCore } from 'gesturecore';

const core = new GestureCore({ aspect: video.videoWidth / video.videoHeight });

// per frame, with any clock you like (ms, non-decreasing)
const events = core.update(hands, t);
for (const e of events) {
  if (e.type === 'pinch:start') { /* … */ }
}
core.getFeatures('Right'); // latest Features or null
```

`update()` is synchronous, the only entry point, and returns an array. There are no
callbacks or emitters.

### Conventions (see `src/types.ts`)

- **Handedness is anatomical.** `'Right'` is the user's real right hand. The *adapter*
  converts MediaPipe's label; the core never flips it.
- **Coordinates** are MediaPipe-normalised `[0, 1]` in whatever frame the adapter
  passes. The bench passes a mirrored (selfie) frame. Only `tilt` and `centroid`
  depend on the frame.
- **`aspect`** (frame width / height) must be set for non-square frames. Without it,
  every distance ratio is distorted.
- **`z`** is used only inside joint angles, never as a distance. Use `span` for
  distance to the camera.

### Events

| event | when |
| --- | --- |
| `engage` | engage pose held for `engage.dwellMs` (immediately if `engage.pose` is `''`) |
| `pinch:start` | engaged, thumb tip within `closed + h` of an enabled fingertip for `dwellMs`; carries `finger` |
| `pinch:move` | every frame between start and end; `finger`, `value` = normalised pinch of that finger |
| `pinch:end` | that finger's distance goes above `closed + 3h`, or the hand is lost |
| `pose` | best qualifying pose held for `dwellMs`; once per hold |
| `motion` | a movement description is satisfied while engaged and not pinching |
| `disengage` | the hand is lost (only way to disengage) |
| `lost` | hand absent for more than `lostAfterMs` |

Within a frame hands are ordered Left then Right. Per hand the order is `engage,
pinch:end, pinch:start | pinch:move, pose, motion`. On loss it is `pinch:end, disengage, lost`.
Every start/engage is paired with an end/disengage before `lost`.

### Engagement

Engagement is a safety clutch. A hand in view is not trusted to act until it shows
the engage pose (default: open palm held for 500 ms). Only then do **pinch** and
**motion** events fire. It stays engaged until the hand leaves the frame for more than
`lostAfterMs`. **Pose** events are not gated. This stops typing, reaching for a mug or
resting your chin from scrolling or swiping. Set `engage.pose` to `''` to skip it.

### Declaring gestures

Gestures are data in the config, so adding one needs no code.

**Poses** (hand shapes): a curl range per finger, scored 0..1.

```json
{ "name": "peace", "fingers": { "index": { "curl": [0, 0.25] }, "middle": { "curl": [0, 0.25] },
  "ring": { "curl": [0.7, 1] }, "pinky": { "curl": [0.7, 1] } } }
```

**Movements** (how the hand travels):

| field | meaning |
| --- | --- |
| `axis` | `x` sideways, `y` up/down, `depth` toward/away from camera, `tilt` palm twist |
| `direction` | `1` = right / down / toward camera / clockwise on screen, `-1` the opposite |
| `distance` | per stroke: hand sizes (x, y), relative size change (depth, 0.25 = 25 %), radians (tilt) |
| `withinMs` | all strokes must happen in this time |
| `reversals` | `0` = one stroke; `3` = four back-and-forth strokes (a wave); direction is then ignored |
| `pose` | optional: only movement made while holding this pose counts |
| `cooldownMs` | optional: minimum gap before it fires again (default 500) |

```json
{ "name": "swipeUp", "axis": "y", "direction": -1, "distance": 1.5, "withinMs": 400 }
{ "name": "wave", "axis": "x", "reversals": 3, "distance": 0.5, "withinMs": 1500, "pose": "openPalm" }
{ "name": "push", "axis": "depth", "direction": 1, "distance": 0.3, "withinMs": 500 }
```

Defaults are `swipeLeft`, `swipeRight` and `wave`. Right/left assume the mirrored view.

### API beyond the original sketch

These additions were needed by the definition of done or by correctness:

| addition | why |
| --- | --- |
| `getHandState(hand)` | the bench must show in-flight dwell progress (charging rings) |
| `getConfig()` | the bench must round-trip config to JSON |
| `Features.pinchRaw` | the value the pinch thresholds actually compare against |
| `config.curl` | curl angle mapping; "every constant live-adjustable" |
| `config.poseFalloff` | per-finger fit falloff outside a range; same reason |
| `config.aspect` | correct distance ratios on 4:3 / 16:9 frames |
| `Features.pinchRaws`, `config.pinch.fingers`, `finger` on pinch events | which finger the thumb pinched |
| `config.motions`, `motion` event, `HandState.motionProgress` | declarative movement gestures |

## Develop

```bash
npm test            # Vitest in Node, no browser environment
npm run typecheck   # core (no DOM lib: browser globals are type errors) + bench
npm run build       # dist/ ESM + .d.ts
npm run fetch-model # bench/models/hand_landmarker.task (7.8 MB)
npm run bench       # http://localhost:5173/bench/
```

On this machine Node is portable and not on PATH. Use `..\run-tests.cmd` and
`..\run-bench.cmd`, which set PATH for their own window only.

## The bench

Open `http://localhost:5173/bench/` in Chrome and press **Start camera**.

- **Header:** *mirror view* flips the image (and the x coordinates the core gets);
  *swap L/R* flips only the hand label. They are independent.
- **Stage:** camera image, raw (grey) and smoothed (coloured) skeletons, plus
  engage (teal), pose (amber) and pinch (pink) charging rings.
- **Readout:** every feature per hand, thumb distance to each fingertip with thresholds
  as ticks, dwell progress, pose scores, movement progress.
- **Tuning:** a slider for every config value and pinch-finger checkboxes. Changes are
  live via `setConfig()` and saved in this browser only.
- **Gestures:** record a pose from your own hand, build a movement with a form, or edit
  either list as JSON.
- **Scroll test:** pinch-drag scrolling plus a false-activation session meter (press `F`).
- **Fixtures:** capture a real hand (averaged over N frames) and save it to `test/fixtures/`.
- **Source:** camera and resolution, MediaPipe confidence thresholds, GPU/CPU.

Keys: `F` marks a false activation, `R` resets the core, `Space` pauses.

## Status and open items

1. **Fixtures are synthetic placeholders.** Capture real `open`, `fist`, `point` and
   `pinch` in the bench's Fixtures tab and re-run `npm test`.
2. **Handedness: verified.** With the unmirrored camera frame, MediaPipe's label is
   already the user's real hand, so the bench no longer flips it by default.
3. **Movement defaults (distance, time) are first guesses.** Tune them in the Gestures
   tab while watching the movement progress bars.
4. **Smoothing `beta = 0.007` is effectively non-adaptive in normalised units.** At
   that value the filter adds about 390 ms before a fast pinch crosses its threshold,
   on top of the 300 ms dwell. The original constant assumed pixel units. In the
   bench, beta 5–20 cut that lag to roughly 60–100 ms. Retune against real hands.
5. **The false-activation target (under 2 per 10 min) is not yet measured.** It needs a
   real 10-minute session in the Scroll test tab. If it fails, retune (likely
   `pinch.closed`, `hysteresis`, `dwellMs`, `engage.dwellMs`) before calling this done.
