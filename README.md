# gesturecore

**Turns hand-tracking landmarks into clean gesture events.**

You give it 21 hand landmarks per frame and a timestamp. It gives you back
`pinch:start`, `pose`, `motion` and friends — debounced, hysteresis-gated and
scale-invariant, so a pinch is one event instead of forty frames of jitter.

```ts
for (const e of core.update(hands, performance.now())) {
  if (e.type === 'pinch:start') console.log(e.hand, 'pinched', e.finger); // → Right pinched index
  if (e.type === 'motion' && e.name === 'swipeLeft') history.back();
}
```

- **No dependencies, no browser APIs.** The library is pure TypeScript: no camera,
  no DOM, no timers, no storage. It runs in a browser, in Node, and in tests.
- **Geometry, not machine learning.** Landmarks in, angles and distances measured,
  thresholds and dwell timers applied. Every decision is inspectable and tunable.
- **Gestures are data.** Poses and movements are JSON, so new gestures need no code.
- **Deliberate by design.** A hand does nothing until it "engages", which keeps
  typing, fidgeting and reaching for a coffee from triggering anything.

## What it is not

It does **not** find hands in an image — feed it [MediaPipe Hand
Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
output, or anything in the same 21-point format. It does not open a camera, control
the mouse or draw a UI. Those belong in whatever app uses it.

## Install

Not on npm yet:

```bash
npm install github:burakTanBilgi/gesturecore
```

Requires Node 18+ for the build; the library itself is ESM with type definitions.

## Quick start

```ts
import { GestureCore, type Hand } from 'gesturecore';

const core = new GestureCore({
  aspect: 640 / 480,                              // frame width / height, required
  engage: { pose: 'openPalm', dwellMs: 500 },     // the safety catch
});

// Per frame, from your landmark source:
const hands: Hand[] = result.landmarks.map((landmarks, i) => ({
  handedness: result.handedness[i][0].categoryName === 'Left' ? 'Left' : 'Right',
  score: result.handedness[i][0].score,
  landmarks,                                       // 21 × {x, y, z}, normalised 0..1
}));

for (const event of core.update(hands, performance.now())) {
  // event.type: engage | pinch:start | pinch:move | pinch:end | pose | motion | disengage | lost
}
```

`update()` is synchronous, is the only entry point, and returns an array. There are
no callbacks and no emitters. It is the caller's job to supply the clock, which is
what makes the whole library testable without a camera.

## Events

| event | when |
| --- | --- |
| `engage` | the engage pose was held for `engage.dwellMs` (immediately if `engage.pose` is `''`) |
| `pinch:start` | engaged, and the thumb stayed within `closed + h` of a fingertip for `dwellMs`; carries `finger` |
| `pinch:move` | every frame between start and end; `finger`, and `value` 0 (touching) … 1 (open) |
| `pinch:end` | that finger's distance rose above `closed + 3h`, or the hand was lost |
| `pose` | the best qualifying pose was held for `dwellMs`; once per hold |
| `motion` | a movement description was satisfied while engaged and not pinching |
| `disengage` | the hand was lost (the only way to disengage) |
| `lost` | the hand has been absent for more than `lostAfterMs` |

Every event carries `type`, `hand` (`'Left' | 'Right'`) and `t`. Within a frame,
hands come Left then Right; per hand the order is `engage, pinch:end, pinch:start |
pinch:move, pose, motion`, and on loss `pinch:end, disengage, lost`. Every
`pinch:start` is closed by exactly one `pinch:end`, and every `engage` by one
`disengage`.

## The ideas

**Span.** Every distance is divided by the wrist-to-middle-knuckle length, so
thresholds hold whether the hand is near the camera or far from it. Distances are in
"hand sizes": 1.0 = one span.

**Hysteresis.** On/off decisions use two thresholds — a pinch closes below
`closed + h` but only releases above `closed + 3h` — so a value resting near the line
cannot flicker.

**Dwell.** A state must hold continuously before its event fires (300 ms by
default). Any frame that breaks it resets the timer. `getHandState()` exposes the
timers as 0..1 progress, which is what the bench draws as filling rings.

**Engagement.** A hand in view is not trusted to act until it shows the engage pose.
Pinches and movements are gated on it; pose events are not. It ends only when the
hand leaves the frame. Set `engage.pose` to `''` to switch the catch off.

## Declaring gestures

**Poses** are curl ranges per finger, scored 0..1 (1 inside the range, fading to 0
`poseFalloff` outside). The best pose above its `minScore` is the held pose.

```json
{ "name": "peace", "fingers": {
    "index":  { "curl": [0, 0.25] }, "middle": { "curl": [0, 0.25] },
    "ring":   { "curl": [0.7, 1] },  "pinky":  { "curl": [0.7, 1] } } }
```

**Movements** describe how the palm travels.

| field | meaning |
| --- | --- |
| `axis` | `x` sideways · `y` up/down · `depth` toward/away from the camera · `tilt` palm twist |
| `direction` | `1` = right / down / toward camera / clockwise; `-1` the opposite |
| `distance` | per stroke: spans (`x`, `y`), relative size change (`depth`, 0.25 = 25 %), radians (`tilt`) |
| `withinMs` | the whole movement must fit in this time |
| `reversals` | `0` = one stroke; `3` = four strokes back and forth (a wave), direction then ignored |
| `pose` | optional: only movement while holding this pose counts |
| `cooldownMs` | optional: minimum gap before it can fire again (default 500) |

```json
{ "name": "swipeUp", "axis": "y", "direction": -1, "distance": 1.5, "withinMs": 400 }
{ "name": "wave", "axis": "x", "reversals": 3, "distance": 0.5, "withinMs": 1500, "pose": "openPalm" }
```

Defaults: poses `fist`, `openPalm`, `point`; movements `swipeLeft`, `swipeRight`,
`wave`. Replace them wholesale with `setConfig({ poses, motions })` — they are only
defaults, not privileged.

## API

| member | purpose |
| --- | --- |
| `new GestureCore(config?)` | config is a deep partial of the defaults |
| `update(hands, t)` | advance to time `t` (ms, non-decreasing) and return the events |
| `getFeatures(hand)` | the latest measurements for a hand, or `null` |
| `getHandState(hand)` | engaged, pinch finger, dwell progress, pose scores, movement progress |
| `getConfig()` / `setConfig(patch)` | read or live-patch the configuration |
| `reset()` | forget all hands and timers |

Everything is configurable: smoothing (`minCutoff`, `beta`, `dCutoff`), pinch
(`closed`, `open`, `hysteresis`, `fingers`), `dwellMs`, `engage`, `lostAfterMs`, the
curl angle mapping, `poseFalloff`, `aspect`, `poses` and `motions`.

## Conventions

- **Handedness is anatomical.** `'Right'` is the user's real right hand. Your adapter
  decides what to do with the tracker's label; the core never flips it.
- **Coordinates** are normalised `[0, 1]` in whatever frame you pass. Only `tilt` and
  `centroid` care whether that frame is mirrored.
- **`aspect`** (frame width / height) must be set for non-square frames, or every
  distance ratio is distorted.
- **`z`** is used only inside joint angles, never as a distance — it is too noisy.
  Use `span` as a proxy for distance to the camera.
- **Time** is milliseconds supplied by the caller and must never go backwards.

## The bench

A tuning workbench ships with the repository. It is the reference adapter (camera →
MediaPipe → core) and the tool for tuning the constants against real hands.

```bash
npm install
npm run fetch-model     # downloads the MediaPipe hand model, 7.8 MB, not in git
npm run bench           # http://localhost:5173/bench/
```

It shows every feature, threshold and timer live, has a slider for every constant,
records new poses from your own hand, builds movements from a form, measures
accidental activations, and captures test fixtures. Panels are dockable
([dockview](https://github.com/dockview/dockview)) and its colours carry fixed
meanings — cyan measurement, amber charging, green active, red lost, white a limit
you set, grey raw input. The built-in **Docs** panel explains the whole system.

## Develop

```bash
npm test            # Vitest, no browser environment
npm run typecheck   # core (no DOM lib: browser globals are type errors) + bench
npm run build       # dist/ ESM + .d.ts
```

`src/` may not use browser APIs — a test enforces it. The bench (`bench/`) may.

## Status

Early but working: 191 tests, no known bugs, API stable enough to build on. Honest
limitations:

- The test fixtures are **synthetic** (forward kinematics, not real captures) and
  single-view. The bench records real ones from several angles and distances, and
  `views.test.ts` requires every view to read as the same pose — landmark tracking is
  weakest away from a square-on view, so that is where recognition really fails.
- The smoothing default `beta = 0.007` comes from the One Euro paper's pixel-unit
  examples and is very conservative in normalised units; 5–20 behaves better. It has
  not yet been retuned against real hands.
- The movement distances and times are first guesses.
- The "fewer than 2 false activations per 10 minutes" target has not been measured
  yet; the bench's Reliability panel does exactly that.

## AI models

**At runtime**, gesturecore itself uses none — it is geometry. Its *input* normally
comes from Google's **MediaPipe Hand Landmarker** (`hand_landmarker.task`, palm
detection + 21-point landmark models, Apache-2.0), which the bench downloads on
demand. Any source producing the same 21 points works.

**While writing it**, the code, tests and documentation were produced with
**Claude Opus 5** through Claude Code, directed, reviewed and hand-tested by
[burakTanBilgi](https://github.com/burakTanBilgi); **Claude Haiku 4.5** was briefly active in one
session and wrote none of the code. Commits carry `Co-Authored-By` trailers naming
the model that wrote them.

## Credits and licence

- The smoothing is the **One Euro filter** (Casiez, Roussel, Vogel, CHI 2012).
- The bench docks its panels with **dockview** (MIT) and tracks hands with
  **MediaPipe Tasks Vision** (Apache-2.0).

MIT — see [LICENSE](LICENSE).
