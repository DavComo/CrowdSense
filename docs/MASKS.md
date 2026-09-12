# Simulation masks (`*.mask.json`)

Derived exports, separate from the venue file itself: rasterized grids over
the venue's footprint, meant to feed a set of equations modeling crowd
flow together. **All four share the same grid for a given (venue,
cellSize) pair** — same `origin`, `cellSize`, `cols`, `rows` — so generate
any two with the same cell size and cell `[row][col]` in one lines up with
cell `[row][col]` in the other, no extra alignment step needed.

| Mask | Values | What it shows |
|---|---|---|
| **Walkability** | binary (1/0) | Where a person can physically stand — 0 wherever *any* wall/pillar/block occupies the cell. |
| **Barrier** | binary (1/0) | Where a wall the optimizer is allowed to move/reshape sits — the main mask an ML model edits to lower its cost function. Fixed/locked walls never appear here (they're still in the walkability mask). |
| **Entrance/Exit rate** | signed number | 0 = no entrance/exit (or one explicitly closed); positive = an entrance's flow rate (people/min in); negative = an exit's (people/min out). |
| **Attraction** | binary (1/0) | Where a zone with `attraction: true` sits — areas people gravitate toward. |

## How to get one

In the editor's **Simulation Masks** panel: pick a **Mask** type and a
shared **Cell size**, then either **Debug View…** (opens a separate window
rendering it — see below) or **Export JSON**.

## Shape

```jsonc
{
  "version": 1,
  "type": "crowdsense-walkability-mask",   // or -barrier-, -entrance-exit-rate-, -attraction-mask
  "venueName": "Sample Club Floor",
  "unit": "m",
  "cellSize": 0.25,
  "cols": 128,
  "rows": 88,
  "origin": { "x": -1, "y": -1 },
  "grid": [
    [1, 1, 1, 0, 0, 1, ...],   // row 0
    [1, 1, 0, 0, 0, 1, ...],   // row 1
    ...
  ]
}
```

- `unit` / `cellSize`: same real-world units as the venue file (`meta.unit`
  there) — `cellSize` is in that unit, not pixels.
- `origin`: world coordinates of the grid's top-left corner (`grid[0][0]`'s
  top-left), in the same coordinate frame as the venue file's own
  `x`/`y` values.
- `grid`: `rows` arrays of `cols` values each. Cell `[row][col]` covers the
  world-space rectangle `[origin.x + col*cellSize, ... + cellSize)` ×
  `[origin.y + row*cellSize, ... + cellSize)` — to map a world point to a
  cell: `col = floor((x - origin.x) / cellSize)`,
  `row = floor((y - origin.y) / cellSize)`.

## Walkability & Barrier: what counts as blocked/editable

Both rasterize the venue's `walls` array — line walls (within half their
`thickness` of any segment), pillars (inside their radius), and
rectangular blocks — but over different subsets:

- **Walkability** includes every wall, regardless of `movable`/`extendable`.
- **Barrier** includes only walls where `movable !== false` or
  `extendable !== false` — the ones an optimizer is actually allowed to
  touch. A load-bearing wall (`movable: false, extendable: false`) still
  blocks in the walkability mask but never appears in the barrier mask.

**Zones never block either mask** — a "stage" or "restricted" zone is
still walkable floor here; a real barrier around one would be modeled as
a wall. (The density simulator is the one exception, and only for zone
*types* that are an actual physical structure — `stage` and `restricted`,
`ZONE_BLOCKING_TYPES` in `model/schema.js` — via the separate
`computeZoneFootprintMask`; every other type, like a "seating"/GA-floor
zone, stays walkable there too. See `docs/DENSITY_SIMULATION.md`. These
two masks are unaffected either way and keep the convention below.) A
cell counts as marked if its *center point* falls within an
obstacle's footprint, inflated by that cell's own half-diagonal — without
that inflation, a wall thinner than the cell size could pass through part
of a cell without ever coming near its exact center, leaving gaps in an
otherwise-solid wall as cells get bigger. Trade-off: obstacles read up to
about half a cell thicker than drawn at coarse cell sizes — deliberately
erring toward over-marking rather than leaving a gap.

Both grids cover the venue's content bounding box plus a 1-unit margin,
not just the interior of a closed perimeter wall — the editor doesn't
require walls to form a closed loop, so it never tries to infer "inside
the building" from wall topology.

## Entrance/Exit rate: sign and magnitude

- `entrance` points → positive; `exit` and `emergency-exit` points →
  negative; every other point type (`info`, `security`, `custom`) is
  ignored entirely (always 0).
- The magnitude is the point's `throughput` (people/minute). A point with
  no `throughput` set still gets a placeholder rate (`DEFAULT_THROUGHPUT`,
  60/min — a plausible single doorway, not just a token nonzero value:
  both density simulators use this same fallback as a real simulation
  input, and they'll warn if any point is relying on it) rather than
  being invisible to the mask — only an *explicit* `throughput: 0` reads
  as closed (0 in the grid).
- Each point maps to its single nearest cell. Two points landing in the
  same cell sum (so two adjacent entrances can combine into one cell's
  rate) — this is a rare edge case at a reasonably fine cell size, since
  points that close together on a real floor plan are unusual.

## Attraction: what counts

A zone counts if its `attraction` field is `true` — the field itself is
purely binary (matching this mask exactly), not a weighted strength; a
weighted field is left for the simulation side to build from the venue
file directly, if it needs one.

## Debug viewer

**Debug View…** opens a separate window rendering whatever mask you last
computed — a genuinely different tool window, not a panel in the editor,
so you can leave it open and re-open it with fresh data as you tweak the
venue. Binary masks (walkability/barrier/attraction) render black/white
(with a one-line legend saying which is which for that mask type);
the entrance/exit rate mask — an open range, not just three states —
renders a blue-white-red diverging gradient (blue = exit, white = zero,
red = entrance) with a legend bar showing the actual min/max values.
Hover any cell in either kind of view for its row/column, world
coordinates, and exact value.

## Picking a cell size

Smaller cells = more accurate around doorways and corners, at the cost of
a bigger grid (and slower rasterization/pathfinding). A cell size around
1/4 to 1/2 of your narrowest doorway width is a reasonable starting point.
The editor refuses to rasterize a grid bigger than 4,000,000 cells and
tells you so — pick a larger cell size if you hit that. All four mask
types share the same cell-size control in the editor so they stay aligned
without you having to remember to match it by hand.
