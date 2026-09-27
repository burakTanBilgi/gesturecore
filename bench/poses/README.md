Pose packs, one JSON file each: an array of poses, nothing else.

```json
[
  { "name": "peace", "fingers": {
      "index":  { "curl": [0, 0.2] },
      "middle": { "curl": [0, 0.2] },
      "ring":   { "curl": [0.75, 1] },
      "pinky":  { "curl": [0.75, 1] }
  } }
]
```

Unlike `bench/workspaces/`, these are meant to be shared and committed. Drop a file in
here and the bench's **Gestures → Pose library** lists it; install it and its poses join
your config.

## Why installing someone else's pose is safe

A pose is **declarative data and never code** — a name and some number ranges. Nothing in
a pack is evaluated, and `parsePoses` in the core reads it as a whitelist: every key is
named in advance or the file is refused. It cannot carry a script, reach
`Object.prototype`, or grow a field that does something.

That is the whole argument, and it only holds while the rule does. If a pose is ever
allowed to carry behaviour — a formula, an expression, a callback name — this stops being
true and a pack becomes as dangerous as any plugin.

What a pack can still do is be *wrong*: ranges that overlap your other poses, a `four`
that swallows your `openPalm`, a name that shadows one of yours. The library shows you
every pose in full before you install it, and poses are small enough to actually read.
That reading is the review, and nothing here replaces it.

## About `example-counting.json`

It holds `peace`, `three` and `four` — the three poses the chord brick needs and the core
does not ship. **Its numbers were written, not measured.** No hand was recorded to produce
them; they are a plausible description of each shape, so that the format has an example
and the chord scale can be tried before you own a recording of your own hand.

Treat it as a starting point. If `peace` will not hold, or `three` keeps scoring as
`four`, the pack is wrong for your hand and no amount of tuning the thresholds will fix
that — re-record it.

One thing in it is not arbitrary. `four` constrains the **thumb** to be tucked. Without
that it would constrain only the four fingers, and the core breaks a tie in score by
narrowness, so a thumbless `four` beats `openPalm` on a genuinely open hand and quietly
takes over the letter E. Whatever you record, keep the thumb in `four`.

## Recording your own

**Gestures → Record a pose** reads your real finger curls, so a pose fits the hand that
recorded it. That is always better than a pack someone else wrote, including this one.
Tick **include thumb** whenever the thumb is what makes the shape different.
