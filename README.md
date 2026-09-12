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
  seating, restricted, etc.), and point markers (entrances, exits,
  emergency exits, security posts).
- **Real-world measurements** — a calibration tool: draw a line over a
  known real-world distance (e.g. a door you measured), type in that
  distance, and every coordinate in the file is in real meters/feet from
  then on. A measure tool reports live distances while you work.
- **Trace over a reference image** — import a photo or scanned floor plan
  as a low-opacity background layer to trace over.
- **Import / export** — venues save as plain, human-readable
  `.crowdsense.json` (see [docs/VENUE_FORMAT.md](docs/VENUE_FORMAT.md)),
  and the canvas exports as a flat PNG.
- **Optimization constraints** — mark any wall, zone, or point marker as
  `movable` and/or `extendable` (walls/zones) so the layout optimizer knows
  what it's allowed to rearrange versus what's fixed (a load-bearing wall, a
  rigged stage, a fire-code exit). Locked elements show a 🔒 and can't be
  dragged/resized in the editor either, so what you see matches the file.
- **Undo/redo**, a properties panel for editing selected shapes (name,
  type, color, capacity/flow-rate/stickiness placeholders for the
  simulation to use later), and a live summary (wall/zone/point counts,
  total zoned area).

## Getting started

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

## Controls

| Tool | Shortcut | Behavior |
|---|---|---|
| Select | `V` | Click to select, drag to move, drag a handle to resize |
| Pan | `H` / hold Space | Drag to pan the canvas |
| Wall | `W` | Click to add points, double-click or Enter to finish, Esc to cancel |
| Pillar | `I` | Drag from center outward — a round obstacle (e.g. a column) |
| Block | `B` | Drag to draw — a rectangular obstacle (e.g. a riser or counter) |
| Rectangle Zone | `R` | Drag to draw |
| Circle Zone | `C` | Drag from center outward |
| Polygon Zone | `G` | Click to add points, double-click or Enter to close |
| Point Marker | `P` | Click to place |
| Measure | `M` | Click a start and end point for a live real-world distance |

Scroll to zoom (zooms toward the cursor); use the zoom controls or `Fit` in
the bottom-right to frame everything you've drawn.

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
docs/VENUE_FORMAT.md      The .crowdsense.json schema, written for the sim side
examples/sample-venue.json A small fixture venue to develop against
```

## Where the simulation plugs in

The editor treats crowd-flow math and layout optimization as out of scope
by design — that's the other half of the team's work. The file format
(`docs/VENUE_FORMAT.md`) is the intended interface: zones carry `capacity`
and `stickiness` (avg. dwell minutes) fields, points carry a `flowRate`
field, walls/zones/points carry `movable`/`extendable` flags a designer
sets by hand, and everything is in real-world units, so a separate
script/module can load a `.crowdsense.json`, run a simulation/optimization
pass that only rearranges elements where `movable`/`extendable` allow it,
and either write results back into the same file (under a new top-level
key — unrecognized keys round-trip through the editor untouched) or into
its own output alongside it.
