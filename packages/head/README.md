# gesturecore-head

**A head and face reader for [gesturecore](../core), as an optional brick.** Face
landmarks in; head turns, nods, shakes, blinks, winks, raised brows, an open mouth and a
smile out. It works the way the core does: one synchronous `update()` per frame, the
caller's clock, and gestures declared as data.

The core does not know this package exists. This package uses two of the core's pure
helpers: the One Euro filter, and the stroke detector behind hand movements.

```ts
import { HeadReader, faceFromMediaPipe } from 'gesturecore-head';

const head = new HeadReader({ aspect: 640 / 480 });

// per frame, from a MediaPipe FaceLandmarker created with outputFaceBlendshapes: true
const face = faceFromMediaPipe(faceLandmarker.detectForVideo(video, t));
for (const e of head.update(face, t)) {
  if (e.type === 'motion' && e.name === 'nod') confirm();
  if (e.type === 'expression:start' && e.name === 'browRaise') crescendo();
  if (e.type === 'expression:end' && e.name === 'browRaise') console.log('held', e.heldMs, 'ms');
}
```

## What it reads

| reading | unit | from |
| --- | --- | --- |
| `yaw` | degrees, + = the user turns to *their* right | landmarks |
| `pitch` | degrees, + = looking up | landmarks |
| `roll` | degrees, + = head tilted toward the user's right shoulder | landmarks |
| `blinkLeft`, `blinkRight` | 0 open … 1 shut, per anatomical eye | landmarks |
| `brows` | 0..1, eyebrows raised (the stronger of inner and outer) | blendshapes |
| `frown` | 0..1, eyebrows pulled down | blendshapes |
| `mouthOpen`, `smile` | 0..1 | blendshapes |
| any blendshape by name | 0..1, e.g. `cheekPuff`, `jawLeft` | blendshapes |

**Head angles** come from fitting MediaPipe's canonical face model to the observed face
(least-squares rotation, Horn 1987). The fit uses only points that do not move with an
expression: forehead, nose, eye corners and the sides of the face. Talking, smiling or
raising the brows does not move the angles. The angles are split up as yaw, then pitch,
then roll, which is the order the head turns on the neck.

**Eyes** use the eye aspect ratio (Soukupová and Čech, 2016): lid opening over eye width,
measured in 3D so that a turned head barely changes it. Left and right are the user's own.
They are measured from the landmarks rather than from blendshapes, so they never depend
on which side a tracker calls "left".

**Brows, frown, mouth and smile** come from the tracker's blendshape scores, averaged over
both sides. Without blendshapes those readings are absent, and expressions that use them
never fire.

## Expressions — held states

An expression is a set of ranges on readings that must all hold at once. It has a dwell
before it starts, and hysteresis before it ends, just like a hand pose.

```json
{ "name": "browRaise", "when": { "brows": [0.45, 1] } }
{ "name": "winkLeft",  "when": { "blinkLeft": [0.6, 1], "blinkRight": [0, 0.3] }, "dwellMs": 200 }
{ "name": "tiltRight", "when": { "roll": [15, 90] } }
```

Events: `expression:start`, then `expression:end` with `heldMs`. The defaults are
`browRaise`, `frown`, `mouthOpen`, `smile`, `blink`, `winkLeft`, `winkRight`, `turnLeft`,
`turnRight`, `lookUp`, `lookDown`, `tiltLeft` and `tiltRight`. Replace them wholesale
with `setConfig({ expressions })`.

## Movements — nods and shakes

A movement is a set of strokes on one angle. It uses the same description, and the same
detector, as a hand movement, measured in degrees.

```json
{ "name": "nod",   "axis": "pitch", "reversals": 1, "distance": 8,  "withinMs": 900 }
{ "name": "shake", "axis": "yaw",   "reversals": 2, "distance": 10, "withinMs": 1200 }
```

## Neutral

Angles start at zero when the head faces the camera squarely. People rarely sit that way:
the camera may be off to one side, or above the screen. `calibrate()` takes the current
pose as neutral, and the current eyes as fully open. From then on, angles are measured
from that pose. The difference between the two poses is computed as a rotation, not by
subtracting angles. `getNeutral()` and `setNeutral()` let you save the neutral and restore it.

## Conventions

- **`aspect`** (frame width / height) must be set for non-square frames, or every angle
  is distorted.
- **Mirroring.** Pass raw camera frames with `mirrored: false`, the default. If your frames
  are mirrored, say so with `mirrored: true`. A tracker reads a mirrored face as an
  ordinary one, which reverses turn and tilt and swaps the eyes; the reader undoes that.
- **One face.** `update()` takes one face or `null`. When a face is absent for longer than
  `lostAfterMs`, every active expression ends and then `lost` fires.
- **Time** is milliseconds supplied by the caller. A frame older than the last one is
  ignored.
- **No browser APIs.** The reader is pure and runs in Node, in a worker or in a test, and
  a test enforces that.

## API

| member | purpose |
| --- | --- |
| `new HeadReader(config?)` | the config is a partial of the defaults |
| `update(face, t)` | advance to time `t` and return this frame's events |
| `getReadings()` | the latest readings, or `null` |
| `getState()` | found, and per-expression and per-movement progress |
| `calibrate()` / `getNeutral()` / `setNeutral()` | the neutral pose |
| `getConfig()` / `setConfig(patch)` | read or live-patch the configuration; bad input throws before anything changes |
| `reset()` | forget the face and every timer |
| `faceFromMediaPipe(result, i?)` | a Face Landmarker result → `Face` |
| `measure`, `headRotation`, `eulerDegrees`, `eyeAspect` | the pure measurements |

Events: `face`, `expression:start`, `expression:end`, `motion`, `lost`. Each carries
`type` and `t`.

## Tests and limits

The tests build faces from the canonical face model, turned by exactly known angles and
with eyes opened to exactly known ratios, including mirrored frames. The reader has to
recover the angles to within a millionth of a degree, and to keep them steady under noise
and changes of expression. The tests are also checked the other way: deliberately
breaking the maths makes them fail.

The default thresholds are first guesses. The real Face Landmarker's depth is less
exact than its x and y, so at large angles the degrees are approximate. The bench's
**Head** panel exists to tune both against real faces.

## Credits

The canonical face model and the Face Mesh topology are from Google's
[MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache-2.0).

MIT.
