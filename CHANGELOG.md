# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Until 1.0.0, a new feature or a change in
behaviour raises the minor version and a fix raises the patch version.

There are three version numbers:

- **the project** (root `package.json`, git tags `vX.Y.Z`): the bench and the site, shown
  in the bench's header badge;
- **`gesturecore`** (`packages/core`);
- **`gesturecore-sound`** (`packages/sound`).

## [Unreleased]

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
