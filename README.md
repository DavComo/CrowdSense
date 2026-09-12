# CrowdSense

A desktop editor for modeling venue floor plans — concerts, clubs,
conventions — with real-world measurements, so crowd-flow simulation and
layout optimization can be built on top of it. Built for HackCMU.

This repo currently covers the **venue editor** (drawing, measuring,
importing/exporting). The crowd-flow math and optimization itself is a
separate, in-progress piece — see [Where the simulation plugs in](#where-the-simulation-plugs-in).

## Features

- **Draw a venue to scale** — line walls, pillars, and rectangular blocks
  (physical obstacles), rectangular/circular/polygon zones (stage, bar,
  seating, restricted, etc.), and entrance/exit points.
- **Rotation** — rectangular zones and wall-blocks can be rotated (drag the
  handle above a selected one, or type an exact angle in the properties
  panel); resizing a rotated rect keeps the opposite corner fixed in place.
- **Real-world measurements** — a calibration tool: draw a line over a
  known real-world distance (e.g. a door you measured), type in that
  distance, and every coordinate in the file is in real meters/feet from
  then on. A measure tool reports live distances while you work.
- **Trace over a reference image** — import a photo or scanned floor plan
  as a low-opacity background layer to trace over.
- **Import / export** — venues save as plain, human-readable
  `.crowdsense.json` (see [docs/VENUE_FORMAT.md](docs/VENUE_FORMAT.md)),
  and the canvas exports as a flat PNG.
- **Optimization constraints** — mark a wall `movable` and/or `extendable`
  so the layout optimizer knows what it's allowed to rearrange versus
  what's fixed (a load-bearing wall vs. a movable partition). Locked walls
  show a 🔒 and can't be dragged/resized in the editor either, so what you
  see matches the file. Walls are the only element type with this — zones
  and points keep only aesthetic and mask-facing properties (see below).
- **Entrances/exits snap to the nearest fixed wall** — a real entrance is
  an opening in a permanent wall, not a point floating on open floor, so
  placing or dragging one always pins it onto the nearest wall that isn't
  `movable`/`extendable`.
- **Undo/redo**, a properties panel for editing selected shapes (name,
  type, color, rotation for rects, and the one number/flag per shape that
  actually feeds a mask — zone `attraction`, point `throughput`), and a
  live summary (wall/zone/point counts, total zoned area).
- **Simulation masks** — four grids for a crowd-flow model, all aligned to
  the same cell grid: **Walkability** (walkable vs. any obstacle),
  **Barrier** (just the walls the optimizer may move/reshape — the one it
  edits to lower its cost function), **Entrance/Exit rate** (signed
  people/minute per entrance/exit), and **Attraction** (zones people
  gravitate to). Walkability also previews live as a canvas layer; any of
  the four can be inspected in a separate debug-view window (black/white
  for binary masks, a colored gradient + legend for the open-range
  entrance/exit mask) or exported as JSON. See [docs/MASKS.md](docs/MASKS.md).
- **Crowd simulation** — two interchangeable engines over those masks:
  an **agent-based** Helbing social-force model (individual people,
  running in a WebAssembly module for native speed, the default — it's
  what actually gives dense/sparse texture as a crowd forms) and a
  **continuum** Hughes model (one scalar density field, eikonal routing,
  a Weidmann/Kladek speed law, cheaper at very large crowd sizes). Set a
  max people count, a time step, and a total time, and either produces an
  array of density snapshots over time, played back in a separate window
  with play/pause, a scrub slider, and conservation/evacuation-time
  stats. See [docs/DENSITY_SIMULATION.md](docs/DENSITY_SIMULATION.md).

## Getting started

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

## Controls

| Tool | Shortcut | Behavior |
|---|---|---|
| Select | `V` | Click to select, drag to move, drag a corner to resize, drag the top handle to rotate (rects only) |
| Pan | `H` / hold Space | Drag to pan the canvas |
| Wall | `W` | Click to add points, double-click or Enter to finish, Esc to cancel |
| Pillar | `I` | Drag from center outward — a round obstacle (e.g. a column) |
| Block | `B` | Drag to draw — a rectangular obstacle (e.g. a riser or counter) |
| Rectangle Zone | `R` | Drag to draw |
| Circle Zone | `C` | Drag from center outward |
| Polygon Zone | `G` | Click to add points, double-click or Enter to close |
| Entrance/Exit | `P` | Click to place — snaps onto the nearest fixed wall |
| Measure | `M` | Click a start and end point for a live real-world distance |

Scroll to zoom (zooms toward the cursor); use the zoom controls or `Fit` in
the bottom-right to frame everything you've drawn.

**Snapping**: while drawing or dragging anything, the cursor snaps onto
nearby wall/zone/point vertices (shown with a small teal ring) so new walls
actually connect to existing ones instead of landing a fraction of a unit
off. For Wall and Polygon Zone specifically, clicking back near your own
shape's start point closes the loop and finishes it in one click, instead
of needing double-click/Enter. Starting or ending a new wall on an
existing vertex makes them the same node from then on — dragging one end
of that joint (via its handle in Select mode) drags every wall that shares
it, instead of leaving the others behind.

**Angle snapping**: when drawing a Wall or Polygon Zone (or taking a
Measure/Calibrate reading), the current segment's angle is always shown —
teal and locked when it's close enough to snap, gray otherwise. A line's
*first* segment locks to world horizontal/vertical/15°-increments; every
segment after that locks relative to the previous one instead (so the
corner it forms comes out at a clean turn — straight ahead, 90° off, etc.
— regardless of which way the wall as a whole is oriented). Past the first
corner this also draws as a protractor-style arc "inside" the turn rather
than a bare compass number, labeled with the interior angle (a straight
wall is literally a 180° semicircle). Vertex snapping always takes
priority over angle snapping when both apply. Hold Shift for a plain
0.5-unit grid snap when neither is close enough to engage.

**Deleting a single node**: in Select mode, click (don't drag) a wall or
polygon-zone's vertex handle — it turns red — then press Delete/Backspace
to remove just that point instead of the whole shape. Dropping a wall
below 2 points or a polygon below 3 removes the whole thing instead, since
there's no valid shape left.

## Project layout

```
src/
  main/main.js          Electron main process: window, native menu, file dialogs
  preload/preload.js     contextBridge — the only fs access the renderer gets
  renderer/
    app.js                Wires up toolbar/panels/menu to the model + canvas
    model/                Venue data model, schema, undo/redo history
    canvas/                Rendering (CanvasView) + input handling (InputController)
    ui/                     Properties panel + a small modal helper
    sim/masks.js             Pure computation: venue -> the four mask grids (no DOM dependency)
    sim/density.js           Continuum crowd-flow engine (Hughes model) + shared geometry setup
    sim/density-agents.js    Agent-based crowd-flow engine (Helbing social force) — drives the WASM module
    sim/wasm/                Compiled WASM module (checked in — see native/BUILD.md to rebuild)
    mask-viewer.html/.js     The separate debug-view window for inspecting a mask
    density-viewer.html/.js  The separate playback window for a density simulation result
native/crowd_sim.c        The agent-based engine's C source, compiled to WebAssembly
native/BUILD.md           How to rebuild the WASM module (not needed for normal use)
docs/VENUE_FORMAT.md      The .crowdsense.json schema, written for the sim side
docs/MASKS.md             The four mask types + their *.mask.json export format
docs/DENSITY_SIMULATION.md The crowd-flow model, its inputs/outputs, and known edge cases
examples/sample-venue.json A small fixture venue to develop against
```

## Where the simulation plugs in

The editor now ships a working crowd-flow simulation itself (see
[docs/DENSITY_SIMULATION.md](docs/DENSITY_SIMULATION.md)), but layout
*optimization* — automatically rearranging walls to improve flow — stays
out of scope by design, since that's the other half of the team's work.
The file format (`docs/VENUE_FORMAT.md`) is the intended interface: zones carry a boolean
`attraction` field, points carry a `throughput` field (people/minute an
entrance/exit can pass), walls carry `movable`/`extendable` flags a
designer sets by hand (the only element type that does — they're what the
barrier mask is built from), and everything is in real-world units, so a
separate script/module can load a `.crowdsense.json`, run a
simulation/optimization pass that only rearranges walls where
`movable`/`extendable` allow it, and either write results back into the
same file (under a new top-level key — unrecognized keys round-trip
through the editor untouched) or into its own output alongside it.

For the geometry side specifically, the editor also ships ready-made
rasterizers (`src/renderer/sim/masks.js`, no DOM dependency — usable
straight from Node) for walkability, barrier, entrance/exit-rate, and
attraction grids, all aligned to the same cell grid for a given cell size,
plus their `*.mask.json` export format (`docs/MASKS.md`) — meant to feed
the actual flow equations alongside whatever other fields the simulation
needs.
