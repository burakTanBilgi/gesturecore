# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0.0, a new feature or a change in
behaviour raises the minor version and a fix raises the patch version.

There are five version numbers:

- **the project** (root `package.json`, git tags `vX.Y.Z`): the bench and the site, shown
  in the bench's header badge;
- **`gesturecore`** (`packages/core`);
- **`gesturecore-sound`** (`packages/sound`);
- **`gesturecore-head`** (`packages/head`);
- **`gesturecore-chords`** (`packages/chords`).

Each `package.json` carries its last released version; the numbers below are what the
next release will set them to.

## [Unreleased]

To be released as project 0.3.0, a new feature. gesturecore goes to 0.3.0 and
gesturecore-sound to 0.2.0, both additions only. gesturecore-head and
gesturecore-chords are new, at 0.1.0.

### Added

- **gesturecore-chords** (new package, 0.1.0): chords from two hands, as a brick.
  - One hand counts the letter on its fingers, the other says how it is played. Nothing
    is hardcoded: every shape, the minor shape, the accidental source and the trigger
    come from config, and `noteHand` swaps both hands' jobs at once.
  - The default letters are A–E on one to five fingers (`point`, `peace`, `three`,
    `four`, `openPalm`), `fist` for F and an index pinch for G; a middle-finger pinch on
    the other hand makes it minor.
  - Tilting the note hand past 20° sharpens, flattens when inverted, and releases at 12°
    — a dead band, so a hand held near the edge cannot flap between them.
  - Three triggers: `engage` (sounds while the hand is engaged), `sustain` (holds through
    a brief loss of the letter, `releaseGraceMs`) and `latch` (holds until the next).
  - Pure and fully tested: `readChord` is a function of one frame's readings, and
    `ChordReader` only adds the memory a trigger needs.
- **gesturecore:** poses can be switched off and can say when they were added.
  `PoseDescription.enabled` (absent means on, so older configs are unaffected) — a
  disabled pose is still scored, so a panel can show what it would have matched, but
  `bestPose` never picks it, the same bargain as a pinch finger that is measured but not
  ticked. `PoseDescription.addedAt` is an ISO date, carried and never read by the matcher.
- Bench: every pose in **Moves** has a switch beside it and says when it was added — the
  control sits on the row that shows the gesture firing rather than in another panel.
  Recording a pose stamps it; installing one from a pack stamps it unless the pack
  already says when it was made. Switching off the engage pose says so on the row,
  because with it off no hand can engage at all.
- **gesturecore:** `parsePoses` — reads poses out of data this library did not write and
  returns only what is unmistakably a pose, with a line about each thing it refused. A
  whitelist rather than a filter: every key is named in advance, so a file that grows a
  field is rejected loudly instead of accepted with a surprise in it. Names may be in any
  script but cannot be markup; `__proto__`, `constructor` and `prototype` are refused
  anywhere; nothing is ever merged into an existing object.
- Bench: **Gestures → Pose library**. Pose packs are JSON files in `bench/poses/`, listed
  through the same store interface as workspaces. Opening one shows every pose in it in
  full — each finger's range, and a warning on any name that would replace one of yours,
  which starts unticked. **Save my poses** writes your current set back as a pack.
  `bench/poses/example-counting.json` holds `peace`, `three` and `four`; its numbers were
  written rather than measured, and its README says so.
- **gesturecore-chords:** `requireEngaged` (default on) and `playOnEngage` (default off),
  both switchable from the Chords panel. The core names a pose the moment it recognises
  the shape, well before the engage dwell finishes, so the reader used to sound a chord
  while a hand was still on its way up to being engaged at all. Engaging now stays
  silent: the letter the engaging shape spells is held back until a different one is
  made, so it still plays when it is chosen rather than inherited.
- **gesturecore:** `Features.bends` — the joint bend each curl was mapped from, in
  radians, thumb→pinky and unclamped. `curls` is the mapped 0..1 value, so the angle the
  curl thresholds actually compare against was not visible before; `pinchRaw` has always
  been exposed for the same reason.
- **gesturecore-sound:** `holdNotes(notes, voicing)` and the pure `planNotes` behind it —
  a set of notes held as one voiced chord, one slot per note, the gain shared between the
  notes actually sounding. Silent unless the engine is running.
- Bench: a **Chords** panel — the letter each hand is holding, which are recorded and
  which are not, the chord now playing, and a JSON editor for letters, quality and
  accidentals. Chord starts and ends appear in the log.
- Bench: **save my workspace**, in the Panels menu. A named layout is written to
  `bench/workspaces/<name>.json` through a `WorkspaceStore` interface — the dev server
  writes the file; anywhere else falls back to this browser. The folder is today's
  backend, not the design: a deployed bench swaps the implementation, so nobody has to
  clone the project to keep a layout.
- Bench: **Tuning → Readouts** sets how often the digits are allowed to change, once a
  second by default.
- **gesturecore-head** (new package, 0.1.0): a head and face reader built as a brick.
  - Head yaw, pitch and roll come from a least-squares fit of MediaPipe's canonical face
    to expression-free landmarks.
  - Eye closure per anatomical eye comes from the eye aspect ratio.
  - Brows, frown, mouth and smile come from blendshapes.
  - Expressions are declarative held states, with dwell and hysteresis.
  - Nods and shakes are found by the core's stroke detector.
  - `calibrate()` sets a neutral pose; mirrored frames are handled.
  - Pure, and tested on synthetic faces with exactly known angles.
- Bench: a **Head** panel, off until switched on. It shows live angles, eyes and
  expression levels, each expression's dwell and each movement's progress, a neutral
  button and a JSON editor. The camera view draws the face outline and the direction the
  head points, and the log shows head events.
- Bench: `?demo&head` plays a synthetic face (nod, shake, tilt, blink, brow raise, turn).
  `?head` switches the reader on at load. `?selftest` also loads the face model.
- `npm run fetch-model` also fetches the MediaPipe face model (3.8 MB, pinned by
  SHA-256), and the site hosts it.

### Changed

- Bench: the hand and face models share one MediaPipe runtime load.
- Bench: numbers that round to zero no longer show as `-0`, and the log's hand column is
  wide enough for "Right".
- Bench: the manual is its own page (`bench/docs.html`), reached by **Docs** in the
  header, and no longer a panel in the dock. A reference document was competing for
  space with live instruments, and it was 45 % of the bench's markup — `bench/index.html`
  went from 104 KB to 53 KB. The tokens, reset, type and backdrop both pages share moved
  to `bench/theme.css`. Anchors now work as ordinary links, so the manual can be
  bookmarked, printed and kept open on a second screen.
- Bench: the readouts are quieter, so the panels can be read rather than watched.
  - Digits commit at most once a second. A figure repainted 30 times a second registers
    as motion, not as a value, and with ~60 rows on screen that was most of why the bench
    read as a cockpit. HF-STD-001B 5.6.5.1.3 makes the once-a-second limit a "shall".
    Bars still move every frame — a length is read as a shape.
  - Measurements are drawn in grey; colour now means state, not data. A bar turns green
    only when something has actually happened, per 5.6.6.2.1.8 (code by shape first,
    colour as the redundant layer).
  - Every tuning slider that is a threshold on a measurable reading carries that reading
    on its own track, as one grey needle per finger per tracked hand: the pinch `closed`
    and `open` thresholds against the live fingertip distances, the curl angles against
    the live joint bends. 5.4.1.1.3.1 asks for a control beside the display it affects;
    these sliders cannot move to the hand cards without being duplicated, so the reading
    moves to the slider instead.

## [0.2.0] — 2026-09-17

Project 0.2.0 · gesturecore 0.2.0 · gesturecore-sound 0.1.0

### Added

- **gesturecore:** learning gestures from demonstrations — `fitPose`, `fitMotion` and
  `firesWithin` derive poses and movements from recorded examples and verify the fit.
- **gesturecore:** exports its pure helpers (`extractFeatures`, `LandmarkSmoother`,
  `OneEuroFilter`, `matchPoses`, `bestPose`, `scorePose`, `motionProgress`).
- **gesturecore-sound** (new package, 0.1.0): synthesized cues for gesture events,
  hand-controlled voices with a pinch-to-play theremin preset, a pure planner tested
  without audio, and a Web Audio engine.
- The repository is an npm workspace: `packages/core`, `packages/sound`, and the bench.
- Bench: record a movement by performing it; the pose recorder sets its tolerance from
  what it saw; a Moves catalogue of every gesture; multi-view test captures; a Sound
  panel; a Field panel for the wave backdrop.
- Bench: a published site at <https://gesturecore.vercel.app>, with `?demo` (recorded
  hands, no camera), `?panel=<id>` and `?selftest`, and a header badge naming the build.
- Viewpoint tests: every recorded view of a fixture must read as the same pose, and
  fixtures must survive being moved, scaled, rotated and mirrored.
- Security: a Content-Security-Policy and related headers; the hand model is pinned by
  SHA-256; the dev server's save endpoint refuses cross-site requests.

### Changed

- **gesturecore:** when two poses score the same, the more specific one wins (more
  fingers constrained, then narrower ranges). Previously the first listed won, so a
  pose overlapping a built-in one, such as a thumbs-up against a fist, could never fire.
- Bench: dockable panels, a living backdrop that follows the hands, lighter type,
  Chrome-style tabs with a working Panels menu.
- Bench: served on 127.0.0.1 and opened in Chrome by the launcher.

### Fixed

- Bench: pressing Start camera could fail with "Failed to fetch dynamically imported
  module" after the dev server restarted.
- Bench: Space and R acted before the camera was open, and Space could press a focused
  button.
- Bench: the Panels menu was hidden behind the panels; stray empty boxes in the event
  log; the tab overflow list had no background.
- gesturecore-sound: an unreadable note name is refused when set, instead of failing on
  every frame.

## [0.1.0] — 2026-09-16

The first public release on GitHub.

### Added

- **gesturecore:** hand landmarks in, gesture events out — smoothing (One Euro), scale-
  invariant features, engagement, pinches with the finger that made them, declarative
  poses and movements (swipes, waves, push/pull, twist), and loss handling.
- The tuning bench: live camera, every measurement and timer, sliders for every
  constant, pose recording, fixture capture, a reliability meter and built-in docs.

[Unreleased]: https://github.com/burakTanBilgi/gesturecore/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/burakTanBilgi/gesturecore/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/burakTanBilgi/gesturecore/releases/tag/v0.1.0
