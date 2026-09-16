# Test fixtures

A fixture is a recorded hand the tests replay. It is not a gesture definition (those
live in `src/poses/defaults.ts` and `src/motions/defaults.ts`) and not an image — just
landmarks.

| file | shape |
| --- | --- |
| `open.json`  | open palm, fingers straight |
| `fist.json`  | closed fist, thumb tucked |
| `point.json` | index extended, others curled |
| `pinch.json` | thumb tip on index tip, other fingers open |

## Format

Either a bare array of 21 `{x, y, z}` points (one view), or several views of the same
shape:

```json
{
  "name": "open",
  "hand": "Right",
  "views": [
    { "view": "front", "landmarks": [ { "x": 0.5, "y": 0.5, "z": 0 }, "…21 points" ] },
    { "view": "left",  "landmarks": ["…"] }
  ]
}
```

Points are stored **isotropic**: the capture multiplies x and z by the frame's aspect
ratio, so tests can run with `aspect: 1`.

## Why views

A single square-on snapshot is a weak test. Landmark tracking is most accurate facing
the camera and degrades on turned, tilted and distant hands, which is where a gesture
quietly stops being recognised. `views.test.ts` requires every recorded view to read as
the same pose, so each view added tightens the test. It also applies synthetic
transforms — move, scale, rotate, mirror — which cover the maths; real views cover the
tracker's own behaviour.

## Capturing

> The four fixtures here are **synthetic placeholders** generated from forward
> kinematics, not real hands. Record real ones in the bench (`npm run bench` →
> **Fixtures** → *Capture every view*), then re-run `npm test`.
>
> If a real capture fails a test, that is a tuning signal about the defaults, not a
> reason to edit the fixture.
