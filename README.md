# gesturecore

**Hand-tracking landmarks in, clean gesture events out — plus optional bricks that
build on it.**

**Try it:** [gesturecore.vercel.app](https://gesturecore.vercel.app/bench/) with your camera, or
[the demo](https://gesturecore.vercel.app/bench/?demo) with recorded hands. Nothing leaves your
browser.

![The gesturecore bench: a recorded hand pinching. Measurements are drawn in grey and colour is kept for state, so the green bars are the three timers that have actually filled. The tuning sliders on the right carry grey needles showing the live reading each threshold cuts.](docs/screenshots/bench.png)

This repository is a small family of packages. The core stands alone; every other
package is a *brick*: optional, independent, and something the core never knows about.

| package | what it does | depends on |
| --- | --- | --- |
| [`gesturecore`](packages/core) | pinches, poses and movements from 21 hand landmarks; learning gestures from demonstrations | nothing |
| [`gesturecore-sound`](packages/sound) | synthesized sound cues for gesture events, and hand-controlled voices such as a theremin | `gesturecore` types only |
| [`gesturecore-head`](packages/head) | a head and face reader: turns, nods, shakes, blinks, winks, raised brows, mouth, smile | `gesturecore` (its filter and stroke detector) |
| [`gesturecore-chords`](packages/chords) | chords from two hands: one counts the letter on its fingers, the other says how it is played | `gesturecore` types only |

Planned bricks: visuals that react to hands and faces.

## The core in one screen

```ts
import { GestureCore } from 'gesturecore';

const core = new GestureCore({ aspect: 640 / 480 });
for (const e of core.update(hands, performance.now())) {
  if (e.type === 'pinch:start') console.log(e.hand, 'pinched', e.finger);
}
```

Full documentation: [packages/core](packages/core#readme).

## Adding sound

```ts
import { GestureSound, readerFor } from 'gesturecore-sound';

const sound = new GestureSound();
button.onclick = () => sound.start();          // browsers need a user action first

const events = core.update(hands, t);
sound.update(events, readerFor(core));
```

Full documentation: [packages/sound](packages/sound#readme).

## Reading the head

```ts
import { HeadReader, faceFromMediaPipe } from 'gesturecore-head';

const head = new HeadReader({ aspect: 640 / 480 });
for (const e of head.update(faceFromMediaPipe(faceResult), t)) {
  if (e.type === 'motion' && e.name === 'nod') confirm();
}
```

Full documentation: [packages/head](packages/head#readme).

## Playing chords

```ts
import { ChordReader, readerFor } from 'gesturecore-chords';

const chords = new ChordReader();
const read = readerFor(core);
for (const e of chords.update(read, t)) {
  if (e.type === 'chord:start') sound.holdNotes(e.chord.notes);
  if (e.type === 'chord:end') sound.holdNotes([]);
}
```

One hand counts the letter on its fingers; the other pinches its middle finger for minor.
Tilting the note hand sharpens. Every shape is config, so none of that is fixed.

Full documentation: [packages/chords](packages/chords#readme).

## The bench

A tuning workbench for all of it: live camera, every measurement and timer, a slider
for every constant, gesture recording by demonstration, test captures, a sound panel
and a head panel. It is the reference adapter (camera → MediaPipe → core → bricks).

No camera? Add `?demo` to the address and it replays recorded hands through the real
pipeline; [`?demo&head`](https://gesturecore.vercel.app/bench/?demo&head&panel=head) adds a
synthetic face that nods, shakes, tilts, blinks and raises its brows.

| Every gesture the core knows, lit while it happens | The hand-driven wave field, as its own panel |
| --- | --- |
| ![The Moves catalogue: every gesture the core knows, each with a switch and the numbers it is judged by, lit while it happens](docs/screenshots/moves.png) | ![Field panel](docs/screenshots/field.png) |

![The Head panel: the demo face tilting right, with its angles, eyes, expression timers and the log](docs/screenshots/head.png)

![The manual: its own page, with a table of contents and the frame-to-events pipeline drawn out](docs/screenshots/docs.png)

```bash
npm install
npm run fetch-model     # MediaPipe hand and face models, 7.8 + 3.8 MB, not in git
npm run bench           # opens http://127.0.0.1:5173/bench/
```

**Docs** in the header opens the manual, which explains the whole system. It is a page of
its own rather than a panel, so you can keep it beside the bench instead of in place of it.

## Versions

[Semantic Versioning](https://semver.org/), recorded in [CHANGELOG.md](CHANGELOG.md). The
project (bench and site) is tagged `vX.Y.Z`; each package carries its own version. Hover
the bench's version badge to see them all.

## Branches and deployments

- `main` is where development happens. Every push gets its own preview deployment.
- `deploy` is what [gesturecore.vercel.app](https://gesturecore.vercel.app) is built from;
  it moves forward only when a version is released.

The bench's header badge says which one you are looking at: `dev` on your machine,
`preview · <branch>` on a preview, the version number on the published site.

## Develop

```bash
npm test            # every package's tests, Node only
npm run typecheck   # each package, plus the bench
npm run build       # dist/ for every package
```

npm workspaces, no other tooling. The bench and the packages' type checks read each
other's source directly, so nothing needs building while you work.

## AI models

At runtime the packages use none — gestures, head readings and sounds are geometry and
synthesis. The bench feeds the core from Google's **MediaPipe Hand Landmarker**, and the
head reader from the **MediaPipe Face Landmarker** (both Apache-2.0).

The code, tests and documentation were written with **Claude Opus 5** through Claude
Code, directed, reviewed and hand-tested by [burakTanBilgi](https://github.com/burakTanBilgi);
**Claude Haiku 4.5** was briefly active in one session and wrote none of the code.
Commits carry `Co-Authored-By` trailers naming the model that wrote them.

## Licence

MIT — see [LICENSE](LICENSE).
