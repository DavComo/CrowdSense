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
{ "id": "wall_blk1", "shape": "rect", "x": 20, "y": 2, "w": 4, "h": 1.5, "color": "#c9cbd4",
  "movable": true, "extendable": true }
```

- `shape: "line"`: `points` — ordered vertices in world units. Two points =
  a straight wall; more = a connected polyline, **not** implicitly closed.
  `thickness` is in world units (e.g. `0.25` m ≈ a stud wall). A file with
  no `shape` field on a wall predates this field entirely — treat it as
  `"line"`, same as the editor does.
- `shape: "pillar"`: `cx, cy, r` — center and radius, world units.
- `shape: "rect"`: `x, y, w, h` — top-left + size, world units (`w`/`h`
  can be negative, same convention as a `rect` zone below).
- `movable` / `extendable`: see [Optimization constraints](#optimization-constraints-movable--extendable) below. Walls default to `false`/`false` — permanent structure — when drawn in the editor.

## `zones`

Named areas — stage, bar, seating, restricted, etc. — with an optional
`capacity` your simulation can use as a hard cap.

```jsonc
{ "id": "zone_x1", "type": "stage", "name": "Main Stage", "shape": "rect",
  "x": 5, "y": 2, "w": 12, "h": 6, "color": "#e0564f", "capacity": null, "stickiness": null,
  "movable": false, "extendable": false }

{ "id": "zone_x2", "type": "seating", "name": "GA Pit", "shape": "circle",
  "cx": 20, "cy": 15, "r": 8, "color": "#8b7fe0", "capacity": 400, "stickiness": 45,
  "movable": true, "extendable": true }

{ "id": "zone_x3", "type": "restricted", "name": "Backstage", "shape": "polygon",
  "points": [{ "x": 0, "y": 0 }, { "x": 4, "y": 0 }, { "x": 4, "y": 6 }, { "x": 0, "y": 6 }],
  "color": "#8a8d94", "capacity": null, "movable": false, "extendable": false }
```

- `type`: one of `stage`, `bar`, `seating`, `restroom`, `merch`,
  `coat-check`, `restricted`, `custom` — purely descriptive, doesn't
  change behavior. Add your own values freely; the editor will just treat
  an unrecognized type like `custom` for coloring purposes.
- `shape` is one of `rect` (`x,y,w,h` — top-left + size, `w`/`h` can be
  negative), `circle` (`cx,cy,r`), or `polygon` (`points[]`, implicitly
  closed — the editor draws an edge from the last point back to the
  first).
- `capacity`: `null` if unset, otherwise a person count.
- `stickiness`: `null` if unset, otherwise the average number of minutes a
  visitor lingers at/near this zone once they arrive — a dwell-time hook
  for crowd simulation (a merch table or a bar tends to hold people longer
  than a walkway). Purely a number the designer estimates by hand for now;
  nothing in the editor computes or uses it.
- `movable` / `extendable`: see below. Zones default to `true`/`true` —
  the optimizer is free to rearrange them unless a designer locks one down.

## `points`

Single locations — entrances, exits, security posts, etc.

```jsonc
{ "id": "point_p1", "type": "entrance", "name": "Main Entrance", "x": 5, "y": -2, "flowRate": 180, "color": "#5bb98c",
  "movable": false }
```

- `type`: one of `entrance`, `exit`, `emergency-exit`, `info`,
  `security`, `custom`.
- `flowRate`: `null` if unset, otherwise people/minute — a hook for
  ingress/egress modeling.
- `movable`: see below. Points have no `extendable` — there's nothing to
  resize about a single location. Defaults to `false`.

## `background`

An optional traced reference image (e.g. a photographed floor plan) shown
under the drawing at reduced opacity so measurements can be traced over it.
Purely visual — the simulation side can ignore this entirely.

```jsonc
{ "dataUrl": "data:image/png;base64,...", "x": 0, "y": 0, "width": 40, "height": 28, "opacity": 0.6 }
```

## Optimization constraints: `movable` / `extendable`

Every wall and zone carries `movable` and `extendable`; every point carries
just `movable`. These say what the **layout optimizer** is allowed to touch
when it searches for a better arrangement — not what the human designer can
do in the editor (a designer can still flip either flag at any time; the
editor also refuses to drag/resize an element itself while it's locked, as a
visual double-check that matches what you'll see in the file).

- `movable: false` — the optimizer must leave this element's position
  exactly where the designer put it (e.g. a load-bearing wall, a rigged
  stage, a fire-code-mandated exit).
- `movable: true` — the optimizer may reposition it.
- `extendable: false` (walls/zones only) — the optimizer must leave its
  size/shape alone even if it's allowed to move it.
- `extendable: true` — the optimizer may resize/reshape it.

A locked element renders in the editor with a 🔒 next to its label (walls
have no label, so they get a small standalone badge instead — at the
midpoint for a line wall, the center for a pillar or block) and a dashed
outline when `extendable: false`, so a glance at the floor plan tells you
what's fair game before you ever run the optimizer.

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
small venue with a couple of walls, a stage, a bar, and two entrances —
useful as a fixture while building the simulation.
