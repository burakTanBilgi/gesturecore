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
| `pinch:start` | engaged, `pinchRaw < closed + h` held for `dwellMs` |
| `pinch:move` | every frame between start and end, `value` = normalised pinch |
| `pinch:end` | `pinchRaw > closed + 3h`, or the hand is lost |
| `pose` | best qualifying pose held for `dwellMs`; once per hold |
| `disengage` | the hand is lost (only way to disengage) |
| `lost` | hand absent for more than `lostAfterMs` |

Within a frame hands are ordered Left then Right. Per hand the order is `engage,
pinch:end, pinch:start | pinch:move, pose`. On loss it is `pinch:end, disengage, lost`.
Every start/engage is paired with an end/disengage before `lost`.

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

- **Stage:** mirrored camera, raw (grey) and smoothed (coloured) skeletons, plus
  engage (teal), pose (amber) and pinch (pink) charging rings.
- **Readout:** every feature per hand, pinch thresholds as ticks, dwell progress, pose scores.
- **Tuning:** a slider for every config value. Changes are live via `setConfig()` and
  saved in this browser only.
- **Poses:** edit pose JSON live.
- **Scroll test:** pinch-drag scrolling plus a false-activation session meter (press `F`).
- **Fixtures:** capture a real hand (averaged over N frames) and save it to `test/fixtures/`.
- **Source:** camera and resolution, handedness flip, MediaPipe confidence thresholds, GPU/CPU.

Keys: `F` marks a false activation, `R` resets the core, `Space` pauses.

## Status and open items

1. **Fixtures are synthetic placeholders.** Capture real `open`, `fist`, `point` and
   `pinch` in the bench's Fixtures tab and re-run `npm test`.
2. **Handedness flip default is unverified.** Raise your right hand: it should read
   Right. If not, toggle "flip" in Source.
3. **Smoothing `beta = 0.007` is effectively non-adaptive in normalised units.** At
   that value the filter adds about 390 ms before a fast pinch crosses its threshold,
   on top of the 300 ms dwell. The original constant assumed pixel units. In the
   bench, beta 5–20 cut that lag to roughly 60–100 ms. Retune against real hands.
4. **The false-activation target (under 2 per 10 min) is not yet measured.** It needs a
   real 10-minute session in the Scroll test tab. If it fails, retune (likely
   `pinch.closed`, `hysteresis`, `dwellMs`, `engage.dwellMs`) before calling this done.
