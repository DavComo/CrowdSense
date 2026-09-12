# Venue file format (`.crowdsense.json`)

This is the file the editor imports/exports. It's plain JSON so the
simulation/optimization side of the project can read and write it without
touching any Electron/UI code — just parse the file, do math, and either
write the results into a new field or use the coordinates directly.

## Coordinate system

- All positions are in **real-world units** — meters or feet, whichever
  `meta.unit` says. Not pixels. The editor only converts to pixels for
  drawing, using `scale.pixelsPerUnit`.
- Origin `(0, 0)` is wherever the user started drawing; there's no
  required alignment to true north or a building corner.
- `x` increases rightward, `y` increases **downward** (standard canvas
  convention — this matters if you plug coordinates into a physics/graph
  library that assumes y-up).

## Top-level shape

```jsonc
{
  "version": 1,
  "meta": {
    "name": "Warehouse 12 — Winter Show",
    "unit": "m",              // "m" or "ft"
    "createdAt": "2026-09-11T00:00:00.000Z",
    "updatedAt": "2026-09-11T00:00:00.000Z"
  },
  "scale": {
    "pixelsPerUnit": 20        // rendering detail; ignore for simulation math
  },
  "background": null,          // or a traced reference image, see below
  "walls": [ /* ... */ ],
  "zones": [ /* ... */ ],
  "points": [ /* ... */ ]
}
```

Any extra top-level keys you add (e.g. `"simulation": { ... }` with your own
results) survive a full load → edit → save round-trip in the editor — it
only reads/writes the keys it knows about and otherwise passes the rest of
the document through untouched. Same goes for extra keys on individual
zone/point/wall objects.

## `walls`

Physical obstacles — things a person can't walk through. All three shapes
live in the same `walls` array, told apart by `shape`; none of them have a
`name` (they're geometry the sim routes around, not a location someone
would look up by name).

```jsonc
// shape: "line" — the default; a straight or multi-segment barrier
{ "id": "wall_a1b2c3d4", "shape": "line",
  "points": [{ "x": 0, "y": 0 }, { "x": 10, "y": 0 }], "thickness": 0.25, "color": "#c9cbd4",
  "movable": false, "extendable": false }

// shape: "pillar" — a round obstacle, e.g. a support column
{ "id": "wall_col1", "shape": "pillar", "cx": 12, "cy": 6, "r": 0.4, "color": "#c9cbd4",
  "movable": false, "extendable": false }

// shape: "rect" — a rectangular obstacle, e.g. a bar counter, riser, or block
{ "id": "wall_blk1", "shape": "rect", "x": 20, "y": 2, "w": 4, "h": 1.5, "rotation": 15, "color": "#c9cbd4",
  "movable": true, "extendable": true }
```

- `shape: "line"`: `points` — ordered vertices in world units. Two points =
  a straight wall; more = a connected polyline, **not** implicitly closed.
  `thickness` is in world units (e.g. `0.25` m ≈ a stud wall). A file with
  no `shape` field on a wall predates this field entirely — treat it as
  `"line"`, same as the editor does.
- `shape: "pillar"`: `cx, cy, r` — center and radius, world units.
  Rotationally symmetric, so no `rotation` field.
- `shape: "rect"`: `x, y, w, h` — top-left + size *before* rotation, world
  units (`w`/`h` can be negative, same convention as a `rect` zone below),
  plus `rotation` — degrees, clockwise (since `y` is down), applied around
  the rect's own center. `0` (or a missing field, for files predating
  rotation) means axis-aligned.
- `movable` / `extendable`: see [Optimization constraints](#optimization-constraints-movable--extendable) below. Walls default to `false`/`false` — permanent structure — when drawn in the editor. These are the only properties a wall carries beyond its geometry and `color` — no `name`, since a wall is geometry the sim routes around, not a location someone looks up by name.

## `zones`

Named areas — stage, bar, seating, restricted, etc. Zones carry only
aesthetic fields and `attraction` (the one zone property a mask actually
reads — see docs/MASKS.md) — no `capacity`, `stickiness`, `movable`, or
`extendable`; those were cut since nothing in the mask pipeline used them.
Zones can't be locked: the optimizer's editable/fixed distinction
(`movable`/`extendable`) only applies to walls, since only walls feed the
barrier mask.

```jsonc
{ "id": "zone_x1", "type": "stage", "name": "Main Stage", "shape": "rect",
  "x": 5, "y": 2, "w": 12, "h": 6, "rotation": 0, "color": "#e0564f", "attraction": true }

{ "id": "zone_x2", "type": "seating", "name": "GA Pit", "shape": "circle",
  "cx": 20, "cy": 15, "r": 8, "color": "#8b7fe0", "attraction": false }

{ "id": "zone_x3", "type": "restricted", "name": "Backstage", "shape": "polygon",
  "points": [{ "x": 0, "y": 0 }, { "x": 4, "y": 0 }, { "x": 4, "y": 6 }, { "x": 0, "y": 6 }],
  "color": "#8a8d94", "attraction": false }
```

- `type`: one of `stage`, `bar`, `seating`, `restroom`, `merch`,
  `coat-check`, `restricted`, `custom` — purely descriptive, doesn't
  change behavior. Add your own values freely; the editor will just treat
  an unrecognized type like `custom` for coloring purposes.
- `shape` is one of `rect` (`x,y,w,h` — top-left + size before rotation,
  `w`/`h` can be negative, plus `rotation` in degrees around its own
  center — same convention as a `rect` wall above), `circle` (`cx,cy,r` —
  rotationally symmetric, no `rotation`), or `polygon` (`points[]`,
  implicitly closed — the editor draws an edge from the last point back to
  the first). The editor's rotate handle is currently rect-only; a
  polygon has no `rotation` field — reshape one by moving its vertices.
- `attraction`: `true` or `false` — whether people gravitate toward this
  zone. Purely binary; there's no weighted "how strongly" — that's for a
  companion field on the simulation side to build directly from the venue
  file if it needs one.

## `points`

Entrances and exits — the only two point types. Like zones, a point
carries only aesthetic fields plus whatever a mask actually reads
(`throughput`); there's no `movable` since a point's position isn't really
independent in the first place — see the snapping note below.

```jsonc
{ "id": "point_p1", "type": "entrance", "name": "Main Entrance", "x": 5, "y": -2, "throughput": 180, "color": "#5bb98c" }
```

- `type`: `entrance` or `exit`. (Older files may have `emergency-exit`,
  `info`, `security`, or `custom` — the editor migrates `emergency-exit`
  to `exit` on load, since it's the same sign in the entrance/exit-rate
  mask, and drops the other, non-entrance/exit types entirely, since
  they have no valid representation in the reduced schema.)
- `throughput`: `null` if unset, otherwise people/minute this
  entrance/exit can pass — a hook for ingress/egress modeling (how fast a
  crowd can actually get in or out through it). Files saved before this
  field was named `throughput` used `flowRate` for the same thing; the
  editor migrates it automatically on load.
- **Entrances/exits always sit on a wall.** The editor snaps a point's
  `x`/`y` onto the nearest point of the nearest *fixed* wall (`movable:
  false` and `extendable: false` — the same walls excluded from the
  barrier mask) whenever you place or drag one; a real entrance is an
  opening in a permanent wall, not a location floating in open floor. If a
  venue has no fixed walls at all, a point just stays wherever it was
  placed/dragged.

## `background`

An optional traced reference image (e.g. a photographed floor plan) shown
under the drawing at reduced opacity so measurements can be traced over it.
Purely visual — the simulation side can ignore this entirely.

```jsonc
{ "dataUrl": "data:image/png;base64,...", "x": 0, "y": 0, "width": 40, "height": 28, "opacity": 0.6 }
```

## Optimization constraints: `movable` / `extendable`

Walls carry `movable` and `extendable` — the only element type that does,
since these are what the barrier mask (docs/MASKS.md) is built from, and
that's the only mask either flag feeds. They say what the **layout
optimizer** is allowed to touch when it searches for a better arrangement —
not what the human designer can do in the editor (a designer can still
flip either flag at any time; the editor also refuses to drag/resize a
wall itself while it's locked, as a visual double-check that matches what
you'll see in the file).

- `movable: false` — the optimizer must leave this wall's position exactly
  where the designer put it (e.g. a load-bearing wall).
- `movable: true` — the optimizer may reposition it.
- `extendable: false` — the optimizer must leave its size/shape alone even
  if it's allowed to move it.
- `extendable: true` — the optimizer may resize/reshape it.

A locked wall renders in the editor with a small 🔒 badge (at the midpoint
for a line wall, the center for a pillar or block) and a dashed outline
when `extendable: false`, so a glance at the floor plan tells you what's
fair game before you ever run the optimizer.

## Setting real-world scale

The editor's "Calibrate Scale" tool lets a user draw a line over a known
real-world distance (e.g. the width of a door they measured) and type in
that distance; the editor solves for `scale.pixelsPerUnit` from that. Every
other coordinate in the file is already in real units by the time it's
saved — you don't need to know `pixelsPerUnit` to do anything with the
geometry, it's only there so the editor can redraw the file at the right
size.

## Minimal example

See [`examples/sample-venue.json`](../examples/sample-venue.json) for a
small venue with a few walls (including a rotated block), a stage, a bar,
an entrance, and an exit — useful as a fixture while building the
simulation.
