# Fixtures

Each file is a JSON array of exactly 21 `{ x, y, z }` MediaPipe hand landmarks,
stored **isotropic** (x and z already multiplied by frame aspect), so tests run
with `aspect: 1`.

| File         | Pose                                        |
| ------------ | ------------------------------------------- |
| `open.json`  | open palm, fingers straight                 |
| `fist.json`  | closed fist, thumb tucked                   |
| `point.json` | index extended, others curled               |
| `pinch.json` | thumb tip on index tip, other fingers open  |

> **Status: synthetic placeholders.** These were generated from a
> forward-kinematics hand model (plausible bone lengths and joint angles), not
> captured from a camera. Replace each one with a real capture from the bench
> (**Capture fixture** button, which exports in this exact format), then re-run
> `npm test`. Thresholds in the tests are deliberately loose enough that
> real captures of the same pose should still pass; if one doesn't, that is a
> tuning signal, not a reason to edit the fixture.
