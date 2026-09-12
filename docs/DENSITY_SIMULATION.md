# Crowd density simulation

Two interchangeable simulators over the same rasterized masks described
in [MASKS.md](MASKS.md), both answering: *given how fast people arrive and
where they want to go, how does crowd density evolve over time, and where
does it get dangerous?* Both produce the exact same output shape (an
array of density snapshots + a ledger/metrics summary — see below), so the
**Density Playback** window and the rest of the UI don't care which one
produced a given result.

- **Agent-based** ([`src/renderer/sim/density-agents.js`](../src/renderer/sim/density-agents.js))
  — a Helbing-style social-force model, tracking individual people
  directly. The default: it produces genuine person-scale texture (a
  crowd packs tighter right where people are actually pressing against
  each other — a stage barrier, a doorway — and thinner elsewhere), which
  a single scalar density field can't represent (see "Why two
  simulators" below). Runs in a WebAssembly module compiled from
  [`native/crowd_sim.c`](../native/crowd_sim.c) — see
  [`native/BUILD.md`](../native/BUILD.md) if you need to rebuild it.
- **Continuum** ([`src/renderer/sim/density.js`](../src/renderer/sim/density.js))
  — the corrected Hughes model (density `ρ`, eikonal travel-time
  potential `φ`, Weidmann/Kladek speed law, a finite-volume MUSCL/minmod
  solver): one scalar density field evolved by conservation + a speed
  law, no individual people. Cheaper for very large crowds, and closer to
  the original design doc's specified model (see below).

## Running one

In the editor's **Crowd Simulation** panel, set:

- **Engine** — agent-based or continuum (above).
- **Max people** — the simulation admits people through the venue's
  entrances (at the rate its Entrance/Exit rate mask specifies) until this
  many have entered, then simply stops admitting more. People already
  inside keep behaving normally — heading toward an attraction, staying
  once they arrive — for the rest of the run; there's no forced mass-
  evacuation switch once the cap is hit (an earlier version retargeted
  every admitted person to the exits the instant admission hit the cap,
  which looked like the whole crowd abruptly reversing course for no
  visible reason). Exits work the same way throughout the *entire* run,
  independent of admission — anyone who actually ends up near one can
  leave; nothing pulls the rest of the crowd toward one artificially.
- **Time step (Δt, seconds)** — for both engines, this only controls how
  often a frame is *recorded* (and, for the continuum engine, how often
  the route direction re-solves) — the physics itself always integrates
  internally at whatever finer resolution its own stability actually
  needs, regardless of this value. The agent engine's social-force term is
  numerically stiff (see `native/crowd_sim.c`'s module note) and has
  always worked this way; the continuum engine's finite-volume update
  wasn't substepped until this was found to let it violate its own CFL
  condition with this panel's own *default* Δt/cell size (a Courant number
  over 2×, only ever *warned* about, never prevented) — invisible at low
  density, but large enough at high density to look like the crowd
  oscillating wildly cell to cell ("pulsing") instead of settling,
  reproduced directly as a single cell swinging from 5.4 to 2.0 and back
  to 5.4 people/m² across consecutive recorded steps. Fixed the same way
  the agent engine already handled it: the update now runs in as many
  internal sub-steps as its own Courant number needs (with a safety
  margin, since a MUSCL/minmod scheme isn't oscillation-free at the raw
  upwind CFL limit) — transparent to everything else (recorded frame
  count, route-recompute cadence, run length all stay exactly as
  configured), surfaced only as a "ran in *N* internal sub-steps to stay
  numerically stable" note if it ever actually had to. This alone wasn't
  the dominant cause of "pulsing" in practice, though — see step 5 below
  for the bigger contributor (the route-recompute cadence itself).
- **Total time (seconds)** — the simulated horizon. If people are still
  inside when this is reached, the run just stops there (nothing crashes;
  the ledger and final frames still reflect an honest, if incomplete,
  picture).

Click **Simulate Density…**. It reuses the same **Cell size** as the
Simulation Masks panel, so a run always lines up with whatever masks
you've been inspecting. On completion it opens a **Density Playback**
window with play/pause, a scrub slider, a legend, summary stats, and a
live hover readout (exact density at the cursor, for the frame currently
shown) — useful for comparing two specific spots (e.g. "stage front" vs
"back of the crowd") with a real number instead of relying on how two
colors look next to each other on the colormap.

Stacked on top of the heatmap, at full vector resolution (not the density
grid's own blocky cell resolution), is the **same view the editor draws**:
walls, zones (translucent fill, outline, name label), and entrance/exit
points (glyph, name), each in the exact color/shape you drew them in —
replacing what used to be a bare "wall or not" mask with the actual
designed venue, so the simulation reads against the floor plan you
recognize rather than an abstraction of it. It's a separate `<canvas>`
layered exactly over the density canvas (`src/renderer/density-viewer.js`'s
`drawDesignerOverlay`), drawn once per run since the venue's geometry is
static during playback, and it never intercepts the mouse — hovering for
an exact density reading still works right through it. The side-by-side
comparison view (below) gives each pane its own overlay, since the
optimizer may have moved, resized, or removed elements between the
"before" and "after" venues.

## The layout optimizer

**Optimize Layout…**, next to **Simulate Density…**, is a different
feature from the two engines above — it doesn't run either of them. It
invokes [`optimizer/`](../optimizer), a semi-separate Python project (its
own Hughes-continuum simulator, data factory, surrogate model, and
search) merged into this repo, which re-simulates the venue itself many
times over. See [`docs/OPTIMIZER.md`](OPTIMIZER.md) for how that works
and what it costs a layout on.

## Why two simulators

The design doc (D1) chose the continuum model specifically because it's
10-100× cheaper to run at scale, which matters for its actual purpose
there — generating thousands of training samples for an ML surrogate.
That reasoning doesn't disappear, but the continuum model has a real,
inherent limitation for *this* app's purpose (an interactive density
viewer people actually look at): it has no notion of "my immediate
neighbor," only "the density here" via one scalar law `f(ρ)`. A region
that's genuinely congested settles to a roughly *uniform* density (a
traffic-flow shockwave, like backed-up cars at a red light) rather than
the textured, denser-right-at-the-front pattern a real crowd photo shows
— that's not a bug in the implementation, it's what that class of model
predicts. An agent-based model doesn't have this limitation, because
density there is just wherever the individually-simulated people
actually are. Both are kept because they're genuinely different tools:
agent-based for a demo you want to look convincing at real crowd sizes,
continuum for very large crowds or if you specifically want the
literal corrected-Hughes model the design doc specifies.

## The agent-based engine

Each person is a point with a position, velocity, and desired direction —
a standard Helbing-style social force model (Helbing & Molnár 1995;
Helbing, Farkas & Vicsek, "Simulating dynamical features of escape
panic," Nature 2000, the same paper crowd_flow_design_v0.2.md's Appendix
A.3 checks its own parameter table against):

- **Routing is solved once, not every step, and always targets the
  attraction.** Its travel-time field is solved via the same Fast
  Marching code the continuum engine uses, at a uniform free-flow speed —
  *not* re-solved against density like the continuum engine's is. An
  agent's desired direction is just the local downhill gradient of that
  field. Congestion, queuing, and lane-formation all come from the
  social-force terms below reacting to nearby people directly, the same
  way a real person does — this is standard practice for social-force
  models and is dramatically cheaper than an eikonal re-solve every step.
  (A second field toward the nearest exit is also solved but currently
  unused for routing — admission just stops once `maxPeople` is reached,
  with no forced mass-evacuation switch; see "Max people" above. Exits
  still work throughout the run via direct proximity, independent of
  this field.)
- **Forces**: a driving term pulling each agent toward its desired
  velocity; a repulsion from every other agent within range, calibrated
  against actual contact distance (`A·exp((r_i+r_j−d)/B)`, Helbing's
  literal form — not just raw distance from zero, which would only
  become meaningful once two people were nearly coincident and let a
  crowd compress well past its configured size with almost no
  resistance) plus a stiffer "body" term once two people are actually
  touching, so the crowd doesn't visibly interpenetrate at high density;
  and the same repulsion from nearby wall/blocked cells. Integrated with
  semi-implicit (symplectic) Euler, which crowd_flow_design_v0.2.md's own
  Appendix A.3 also references for exactly this kind of spring-like force.
  Wall repulsion is a SOFT minimum over every blocked cell within range,
  not a hard "just the single nearest one": right at a corner (two walls
  meeting at an angle), a hard nearest-cell pick flips discontinuously as
  an agent's position crosses the bisector between the two walls, and the
  repulsion direction jumps with it — an agent sitting near that bisector
  (exactly where crowd pressure pushes it, into the corner) then
  oscillates back and forth across the flip, indefinitely. This was a
  real, measured contributor to "the crowd pulsing," concentrated at
  exactly the room's geometric corners; weighting every nearby candidate
  cell by how much farther it is than the true nearest one, and averaging
  their positions, blends smoothly through the corner instead (a flat
  wall's own nearest cell still dominates the weighted sum well away from
  a corner, so this doesn't change anything there).
- **Numerically stiff, so it substeps internally.** The pairwise
  repulsion term is realistically stiff at short range — real social-
  force implementations integrate at roughly 0.01–0.02s regardless of
  whatever coarser interval results get reported at. This engine does the
  same: every step substeps to a fixed ~0.02s physics resolution
  internally, however large your chosen Δt is — Δt only controls how
  often a frame is recorded.
- **Doors are just points with a rate**, not a multi-cell "patch" the way
  the continuum engine needs — an entrance accrues a fractional "credit"
  at its own rate each substep and spawns one full agent once that credit
  reaches 1 (so admission paces at exactly the requested rate on
  average, the discrete-agent equivalent of 4.6's queue), and an exit
  works the same way in reverse (a credit-gated removal of the nearest
  waiting agent, so a busy exit's own capacity — not instant teleport-on-
  contact — is what actually limits how fast it clears a crowd).
- **Output density** is a Gaussian-kernel density estimate (bandwidth
  σ=0.6m), not a per-cell headcount: each agent's "1 person" is spread
  over a person-scale neighborhood of cells (renormalized to never leak
  into a wall or blocked zone cell, so it still exactly conserves "1
  person" per agent). This is a visualization choice only — it doesn't
  change where anyone actually goes. A per-cell headcount, or even a
  bilinear 4-cell splat (an earlier version of this file used one), packs
  each person into a fraction of a square meter — at typical grid
  resolutions (~0.5m cells) that means one isolated agent in an
  empty area reads *exactly as locally "hot"* as one deep in a genuinely
  packed crowd, since both just concentrate the same single "1 person"
  into the same tiny area. The map ends up all quantization speckle, with
  no visible region-to-region trend — this was confirmed directly from a
  screenshot during testing: front-of-stage and back-of-crowd areas
  looked like the same speckled mix of colors, not a gradient, even
  though the raw crowd distribution already had one (measured directly:
  front ~3.8 people/m² tapering smoothly to <0.1 well before the back —
  the fix made that trend visible instead of erasing it, not created it
  from nothing). A density map is inherently a neighborhood estimate —
  how many people are around *here* — not a literal per-tiny-cell count,
  so this is the more correct choice, not just a smoother-looking one.
- **Frames are recorded far more densely than the continuum engine's own
  ~150-frame target — 1500 by default, each an instantaneous snapshot,
  not an average.** An earlier attempt to fix "the crowd pulsing between
  recorded frames" widened this kernel to σ=1.0m and additionally
  *averaged* every raw physics step's rasterization since the last
  recorded frame together into each played-back frame. That measurably
  reduced frame-to-frame noise, but was reverted after direct user
  feedback that it blurred away the per-person texture this engine exists
  to show in the first place — a real regression, not a worthwhile trade.
  Chasing the actual cause instead (tracing individual agents' raw
  position and velocity every single ~0.02s physics sub-step, across
  several agents in the scenario's apparently "pulsing" quiet corner)
  found **zero** velocity-zeroing or oscillation events — agents there
  were moving smoothly and substantially the whole time; it wasn't a
  quiet corner at all, but a flow corridor. The real cause was the
  *playback*, not the physics: at only ~150 recorded frames for a 300s
  run, played back at a fixed 20fps, each recorded frame is ~2 simulated
  seconds apart — long enough for an agent moving at ~1.3 m/s to cover
  ~2.6m, more than 10 grid cells at a typical 0.25m cell size. Two
  *displayed* frames that far apart look like a jump cut even when the
  underlying motion (as traced directly) is perfectly smooth. The fix is
  to record 10x as many frames (1500) — no blurring of any single frame's
  own content — which measurably drops the average
  |consecutive-frame density change| per walkable cell by roughly 60% on
  the sample club floor scenario (a busy main entrance, 1000-person cap),
  for a proportional but still small amount of extra time (rasterizing
  more often) and memory (a few tens of MB for a typical venue). The
  wall-repulsion corner-blend fix above is kept — it's a genuine,
  non-blurring improvement, unrelated to this playback issue. Some
  residual per-frame texture in lightly-occupied areas is expected and
  correct: a handful of discrete agents wandering through a small patch
  really does swing that patch's headcount (and so its KDE-rasterized
  density) from one moment to the next — ordinary small-sample
  statistical variance, not a bug, and not something a density *map*
  should hide. The continuum engine has no such texture at all (it's a
  smooth field, not discrete individuals) if a perfectly smooth reading
  matters more than per-person detail for a given venue.
- Runs in [`native/crowd_sim.c`](../native/crowd_sim.c), compiled to
  WebAssembly (see [`native/BUILD.md`](../native/BUILD.md)) — chosen over
  a native Node addon specifically so nobody needs a native build
  toolchain to run the app; the compiled `.wasm` is checked into the repo
  like any other asset.

## What the continuum engine computes

Steps 1-2 and 4 below (`computeSimulationDomain` in density.js) are
shared with the agent-based engine — both treat geometry identically
rather than maintaining two copies of "zones are obstacles, doors punch
through their wall" logic that could quietly drift apart. Only the door-
patch spreading (3) and the transport step itself (5-7) are specific to
the continuum engine's own per-cell density field.

1. Rasterizes the venue into the same four masks as the mask panel
   (walkability, barrier is unused here, entrance/exit rate, attraction),
   at your chosen cell size.
2. "Punches through" the walkability grid at every entrance/exit — a real
   door is a full gap through the wall's material, not a single blocked
   cell. An entrance/exit point is snapped onto the *nearest fixed wall's
   boundary* (its nearest edge, not necessarily its centerline — see
   `docs/VENUE_FORMAT.md`), which for a wall with any real thickness can
   land on either face. So this clears a disk around the point sized to
   the wall's local thickness (plus a one-cell margin) — enough to reach
   clear through to the opposite face regardless of which side the point
   landed on. Without this, a door on a thick wall can end up with a
   single open cell stranded outside a still-solid wall, with no path to
   the interior at all — everyone admitted piles up in the thin exterior
   margin around the building and never actually gets inside.
3. Spreads each door's throughput across a cluster of cells sized to what
   that flow can actually sustain (a single grid cell can only pass a
   bounded amount of flux before the model itself would jam it), rather
   than injecting/removing everyone through one cell. Both the patch's
   width and its depth are sized in real units (meters) first, then
   converted to a cell count for the chosen cell size — not the other way
   around — so the same door behaves the same way regardless of grid
   resolution. An entrance also tracks a running admission queue (4.6):
   what its rate can't place this step because its patch is full stays
   queued and gets first claim next step, at the same rate — never
   dropped, and never let in faster than the door's own rate just because
   a backlog built up and room since opened.
4. Blocks zones whose *type* is a real physical structure — `stage` and
   `restricted` (`ZONE_BLOCKING_TYPES` in `model/schema.js`) — as
   physically occupied, unlike the walkability mask's own editor-facing
   convention where zones are just floor. Every other zone type (seating/
   GA floor, a bar, restrooms, merch, coat-check) stays walkable — those
   are floor areas labeled by purpose, not obstacles, and a real venue's
   GA floor is often its single largest area, so blocking it made the
   whole venue read as far emptier than a given admitted headcount should
   look. For a zone that *is* blocked and also `attraction: true` (a
   stage), the actual routing target becomes the ring of walkable cells
   bordering it — real crowds gather *at* a stage, not on top of it. A
   walkable attraction zone (e.g. a bar people should walk up to) needs no
   such ring — its own interior is already walkable and already the
   target.
5. Solves the eikonal equation via the Fast Marching Method to get a
   travel-time field toward the attraction approach ring — every admitted
   person routes toward an attraction for the entire run (see "Max
   people" above); the exit routing target and the automatic switch to it
   that an earlier version had are gone — re-solved every step as density
   reshapes the effective speed field (not periodically: an earlier
   version re-solved only every 10 steps as a performance shortcut, but
   that turned out to be the dominant cause of "the crowd pulsing at
   higher densities" — a periodic re-solve can find a *discontinuously*
   different "fastest" direction from the one currently in use as
   congestion shifts, and undoing that jump at the next re-solve creates
   a real flip-flop feedback loop, amplitude bounded only by ρ_max,
   repeating every N steps. Re-solving every step approximates the
   continuously-adaptive routing the model calls for instead of
   periodically discarding and re-deciding it in one discrete jump —
   measured directly on the sample club floor venue at higher admission:
   the worst cell's steady-state swing dropped by roughly an order of
   magnitude, and the *average* swing across every walkable cell dropped
   by roughly 200×. Still solved via the Fast Marching Method, which
   scales well enough that every-step re-solving remains fast in
   practice.)
6. Derives an actual route-direction vector `e = −∇φ/‖∇φ‖` from that field
   (central differences of φ, same as it re-solves), so each cell has a
   genuine 2D velocity `u = f(ρ)·e` — not just a scalar speed.
7. Steps the density field forward with a finite-volume **MUSCL/minmod**
   scheme (a standard second-order refinement of the design doc's 4.4
   upwind update — its own risk register flags first-order upwind as
   diffusive and names this exact fix as optional future work): each
   face's density is linearly reconstructed a half-cell toward the face
   from the upwind side's own slope-limited gradient, rather than just
   using that cell's raw center value. Plain first-order upwind has
   diffusion proportional to cell size, which showed up as the simulated
   crowd's front visibly outrunning its true physical speed at a coarse
   cell size (a 40% early arrival at cellSize=1m in one test, versus ~5%
   with this scheme) — the same effect that made a location's density,
   once the crowd reached it, undershoot what the equations actually
   predict. The face velocity's own directional decomposition (previous
   point) only fixed *direction*; this fixes *sharpness*.
8. Records a snapshot of the full density grid at roughly 150 points
   across the run (evenly spaced in simulated time, always including the
   very first and last step) — these are the "array of density maps" you
   asked for, played back frame by frame in the viewer.

## Output shape

`runDensitySimulation(...)` resolves to:

```jsonc
{
  "cols": 132, "rows": 132, "cellSize": 0.5, "originX": -1, "originY": -1, "unit": "m",
  "dt": 0.1, "totalTime": 300, "maxPeople": 400,
  "frames": [Float32Array, Float32Array, /* ... one per recorded step ... */],
  "times": [0, 2.0, 4.0, /* ... seconds, one per frame ... */],
  "domainMask": Uint8Array,       // 1 = walkable, 0 = wall/obstacle — same grid every frame
  "rhoMax": 5.4,                   // people/m², for colormap scaling
  "phaseSwitchTime": null,         // always null now — no forced evacuation phase, see "Max people" above
  "ledger": { "admitted": 400.0, "exited": 217.6, "clipped": 12.3, "residual": -0.0007 },
  "metrics": { "t95": null, "peakDensity": Float32Array },
  "warnings": ["..."]
}
```

- **`ledger`** is a running conservation check: `admitted` (people let in
  through entrances) should equal `exited` (people who left through exits)
  plus whoever's still inside plus `clipped` (density that hit `rhoMax`
  and had to be capped — see below). `residual` is what's left over after
  accounting for all of that; it should stay near zero. A large residual
  would mean a bug in the transport step, not a property of a "bad" venue.
- **`metrics.t95`** — an evacuation-time metric — is always `null` now:
  computing it needs a defined "evacuation starts here" moment, which
  doesn't exist without a forced phase switch (see "Max people" above).
  `phaseSwitchTime` is `null` for the same reason. Both are kept as
  fields, rather than removed, in case a future run mode reintroduces an
  explicit evacuation trigger the metric can anchor to.
- This is `runDensitySimulation`'s own return shape — it has no opinion
  about the venue that produced it. The caller (`app.js`'s "Simulate
  Density…" handler, or `optimizer-viewer.js`'s comparison flow) adds a
  `venue` field before handing the payload to the density-viewer window,
  so the playback can draw the designer overlay described above.
- **`warnings`** flags venue-level issues cheaply, before or after the run
  finishes: no entrances (nobody enters), no exits (nobody can leave), no
  attraction zones while there are entrances (admitted people have nowhere
  to route to and jam at the door), or a Δt/cell-size combination whose
  Courant number needed internal sub-stepping to stay stable (see "Time
  step" above — this used to just warn that the run "may be numerically
  unstable" and proceed anyway; it's now handled automatically, and the
  warning just says so).

## The playback legend isn't scaled to the raw peak

A busy door funnels its whole admission rate through a handful of grid
cells — genuinely crowded right there (especially for the agent engine,
which has no hard density cap — see "Peak density" below), but a narrow,
physically-expected choke point, not representative of the crowd
generally. Scaling the colormap to that one hotspot's raw max washes out
the actually-interesting variation everywhere else: a real gradient from
a stage front to the back of a crowd can end up compressed into a sliver
of the color range, reading as flat even though the underlying data isn't
(measured directly in testing: a stage front reading 2-5.5 people/m² next
to a door hotspot reading 20+ — scaling to the door leaves the stage
looking uniformly dim).

`density-viewer.js` scales the legend/colormap to the 95th percentile of
walkable cells' own peak density instead of the raw maximum — robust to a
handful of outlier cells (a door) while still tracking genuine widespread
crush (which spans many cells, so it still pulls the percentile itself
up). `ρ_max` (5.4) is still the floor either way, as a physical reference
line. The **Peak density** stat and the legend's own parenthetical still
report the true absolute maximum when it's notably higher than the
color-scale's own max — that number isn't hidden, just not what
stretches the colormap.

## The simulation domain is the interior only

The three masks are rasterized with **no margin** (unlike the Simulation
Masks panel's debug view, which adds a 1-unit margin around the venue for
visual breathing room). The grid ends exactly at the venue's own content
bounds — which already include the walls' full extent — so there's no
thin ring of nominally "walkable" space just outside the outermost wall
for people to leak into once a door tunnels through it. If people appear
to be simulated *outside* the building, that's this margin; the fix is at
the mask level, not something a venue edit can work around.

## Getting a real "denser near the front" gradient

The model doesn't add an artificial pull toward "the middle" of an
attraction zone — every cell inside it is an equally valid target (φ=0
throughout), so people heading there stop as soon as they cross into *any*
part of it. A large, broad attraction zone means people fan out and stop
near wherever they first entered it, which reads as fairly even density
across the zone. For a visible stage-front crush, draw the attraction zone
as a small, focused strip (the actual front edge people are pushing
toward), not the whole floor in front of the stage — and use a crowd size
large enough, relative to the room, that the front actually saturates
before everyone's admitted. Below that saturation point, an approaching
crowd in mostly-open floor legitimately moves in near-free-flow, which
looks close to a flat, low, uniform density along the way — that's
correct (mass conservation at a roughly constant speed), not a bug. Once
the front does saturate, density piles up there first and a congestion
wave visibly propagates backward from it over time, tapering off with
distance — the "denser near the stage, sparser further back" pattern.

## A known, expected edge case: density clipped at exactly ρ_max

A cell that reaches exactly `ρMax` has `f(ρ) = 0` by the speed law above —
it can't emit outflow until an upstream neighbor's density actually drops
first. In a short, intense admission burst, a few cells right at a busy
door can pin at `ρMax` for a while with no other cells around them dense
enough to relieve them. This is a genuine consequence of the model as
specified (the design doc's regularization term is for the *route* solve
only — transport intentionally uses the unregularized `f(ρ)`), not a bug:
the `ledger.clipped` figure accounts for this density as still inside the
venue rather than silently discarding it, so it shows up as an honest
"there's a hazard here" signal in the stats rather than a conservation
error.

## Performance

Benchmarked at the design doc's reference scale (a 64×64m venue rasterized
at 0.5m cells → a ~132×132 grid, 3,000 steps at Δt=0.1s over a 300s
horizon): **well under 1.5 seconds** wall-clock in plain JS, run
asynchronously with periodic yields so the editor's UI stays responsive
throughout. That's fast enough that a native/WASM rewrite isn't warranted
for interactive use — the current pure-JS implementation is the shipped
one.
