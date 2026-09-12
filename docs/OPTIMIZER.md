# Layout optimizer

**Optimize Layout…**, in the editor's Crowd Simulation panel, opens a
dedicated **Optimize Layout** window and runs
[`optimizer/`](../optimizer) — a semi-separate Python project (its own
Hughes-continuum crowd simulator, a data factory, a small surrogate
model, and a search loop) merged into this repo — on the venue that was
open in the editor when you clicked. That window shows a live progress
bar and log while it runs, then a before/after cost breakdown with two
actions: load the winning layout into the editor, or play both layouts'
density simulations back side by side. One-time setup required: see
[`optimizer/SETUP.md`](../optimizer/SETUP.md).

## The progress window

`src/renderer/app.js`'s "Optimize Layout…" button just hands the current
venue and the Crowd Simulation panel's settings (engine, max people, dt,
total time, cell size) to a new `BrowserWindow`
(`src/main/main.js`'s `window:open-optimizer-viewer` handler,
`src/renderer/optimizer-viewer.html`/`.js`) — it does not run the
optimizer itself. That window's script is what actually invokes
`optimizer:run`, subscribes to the progress/log events below, and drives
its own progress bar (`STAGE_PERCENT`/`STAGE_TEXT` in
`optimizer-viewer.js`, mapped from the stage names below). Because the
run is driven from that window rather than the main one, the main editor
window stays fully usable while an optimization is in progress.

Most stage transitions are still just boundary markers (`loaded`,
`surrogate_training_start`, `search_start`, …), so the bar's width for
those is a fixed, measured approximation of where wall-clock time
actually goes. The two stages that actually dominate wall-clock time —
generating training data, and the final re-simulation of every candidate
— are different: `run_pipeline.py` uses `pool.imap` (not `pool.map`) for
both, so it can emit a `training_data_progress`/`verify_progress` event
with a running `done`/`total` as each sample or candidate actually
finishes, rather than only a start and an end marker for the whole batch.
`optimizer-viewer.js` interpolates those into that stage's slice of the
bar (`done/total` of the way from `training_data_start`'s percent to
`training_data_done`'s, same for verify), so the bar keeps moving through
the ~75-point span training data alone can take up, instead of sitting at
one number for most of the run and then jumping.

## What actually happens on click

The optimizer-viewer window's `optimizer:run` handler writes the venue it
was given to `optimizer/data/optimize-runs/run-<timestamp>/venue.json`
and spawns `optimizer/run_pipeline.py --venue ... --out ...
--progress-json` in the optimizer's own virtualenv, streaming its
progress back as it goes. That script
([`optimizer/run_pipeline.py`](../optimizer/run_pipeline.py)):

1. Packs every `movable: true` wall/zone/point into one flat parameter
   vector ([`optimizer/arena.py`](../optimizer/arena.py)'s `build_spec`/
   `unpack`) — position always, size too when `extendable: true`, and (for
   a movable **wall**, i.e. furniture — a pillar, a block, a movable
   divider) presence as well: the optimizer can decide a layout is better
   *without* that piece of furniture entirely, not just repositioned. Zones
   and points don't get this — a zone is an area/purpose label, not a prop
   to delete, and an entrance/exit must always exist. A removed element is
   dropped from the venue outright in the result (`_apply_geo`), not just
   moved off-screen or shrunk to nothing.
2. Scores ~100 random layout vectors on the **real** simulator
   ([`optimizer/sim.py`](../optimizer/sim.py): Weidmann speed law,
   eikonal routing, finite-volume upwind — the same model class as this
   app's own continuum engine, an independent Python implementation) —
   in parallel, across every CPU core available.
3. Trains a small surrogate net to imitate that cost cheaply.
4. Searches through the **frozen surrogate** via gradient descent from
   many starting points — this is the "ML" part.
5. **Re-simulates every candidate on the real simulator** before
   believing any of it (design doc D4's safety net) — including the
   surrogate's top picks *and* the best directly-sampled layout, since a
   surrogate that hasn't earned trust yet (held-out R² below 0.7) should
   never be allowed to just win by default.
6. Picks whichever candidate actually scored best on the real simulator
   — falling back to the original layout if nothing beat it, and to
   plain random sampling if the surrogate's picks didn't beat that
   either.

Every step re-simulates a **suite** of scenarios (normal circulation, an
evacuation, a headliner surge, plus two random incidents elsewhere on the
floor) with the design doc's own horizons, not just one — a layout that's
fast to evacuate but crushes people the moment a performer takes the
stage still scores badly.

## The cost function

Explicitly **not** mean density. Per cell, per timestep, the simulator
already computes a softplus excess-density penalty above `ρ_safe = 2.5
people/m²` — the Fruin Level-of-Service D/E threshold, a standard
pedestrian-planning crowding line — and that penalty is integrated over
**both space and time** (`optimizer/sim.py`'s `appraise()`): a cell that's
briefly over threshold contributes little, one that stays crowded for
minutes contributes a lot. A single number (peak density, or a
mean) can't tell those apart, and was tried and rejected here for
exactly that reason (see `appraise()`'s own docstring for a measured
example: peak-density scoring called a real before/after pair a 39%
improvement; the time-integrated score called the same pair +3%, because
it was briefly *worse* before pulling ahead). T95 (evacuation time),
sustained-danger area, and a velocity-variance pressure proxy are all
still computed and reported (design doc 4.9), just not blended into the
one number being optimized.

**A layout can score a near-perfect cost by hiding a region from the
model entirely, not by actually making it safer.** Cost only integrates
the density the simulator computed at each cell — a region the model
thinks nobody can ever reach (walled off from every entrance/populated
zone, even if that's a rasterization/connectivity artifact rather than a
deliberate choice) legitimately contributes zero excess-density cost,
since zero simulated people were ever there. `sim.py`'s own `appraise()`
docstring calls this out directly: *"a layout that traps a ... pocket of
people who can never reach an exit will not be penalized by cost ...
Filter on `disconnected` explicitly wherever a candidate is accepted or
rejected — don't rely on `cost` alone."* `sim.is_valid()` exists
specifically for this, kept deliberately separate from `cost` rather than
folded into it — and `run_pipeline.py`'s candidate selection calls it on
every scenario in a candidate's suite before ranking, disqualifying
anything disconnected (or over a 2%-unplaced bar) regardless of how good
its cost looks, rather than picking the argmin of cost outright. The
per-scenario `disconnected` flag is also printed in the before/after
report. (This safety net was added after exactly this failure mode showed
up in practice: a candidate scored the lowest cost of the whole batch —
an apparent 82% improvement — purely because part of its floor had become
unreachable in the simulator's own routing, not because it was actually a
better layout.)

## Overlap rules: zones, furniture, and the one exception

Two zones stacked on each other, or two pieces of furniture stacked on
each other, are never allowed — a purpose-label can't share its square
footage with another purpose-label, and two solid objects can't occupy
the same footprint. Furniture standing *inside a zone* is the one
exception, and only when that zone is **walkable**: a column or a riser
in an open GA floor is a completely normal architectural pattern, not an
overlap in any meaningful sense. Furniture inside a **non-walkable**
zone (a stage, a restricted area — already an obstacle in its own right)
still counts as a real overlap. Walkability follows the same rule as
everywhere else in this project: an explicit `walkable` field on the
zone first, falling back to `stage`/`restricted` blocking by type
otherwise (`arena._classify_zone`, mirrored by the editor's
`isZoneWalkable()`).

`arena._resolve_overlaps` pushes/shrinks movable elements apart as a
best-effort correction during decoding, but only within kind — a zone
rivals other zones (movable or locked; a designer can lock one in place,
e.g. a permanent GA floor, and the optimizer still has to steer clear of
it), a solid rect/pillar wall rivals other solid walls. It deliberately
does NOT try to correct a zone-vs-furniture relationship, even the
disallowed non-walkable-zone case, because doing so would silently move
geometry that may not have been a decision variable for that pairing at
all — verified directly: an earlier version that unified the correction
across kinds broke `default_u`'s own "reproduce the file exactly"
guarantee for three real venues that happen to draw furniture inside a
zone. Nor is `_resolve_overlaps` a hard guarantee even within a kind — a
room too small for everything at its current size, or 3+ elements
mutually overlapping, can still leave one unresolved (the editor's own
overlap handling documents the same ~5% residual).

The actual guarantee is a hard gate on top: `arena.layout_overlaps()`
looks at the *final* decoded layout — every zone against every other
zone, every solid wall against every other solid wall, and every solid
wall against every NON-walkable zone (walkable ones are skipped, by
design) — and `run_pipeline.py` disqualifies a candidate outright if it
returns true, regardless of cost, the same way a disconnected crowd
disqualifies one. Since this checks relationships the corrector
deliberately leaves alone, a venue whose original layout already has a
furniture-inside-a-non-walkable-zone relationship will legitimately show
`original` as invalid too — that's correct, not a bug: the gate is
honest about what's actually there, even though nothing tries to fix
that specific relationship for you. A "layout overlap check" line in the
report, and an `[overlap]` tag next to any disqualified candidate, say
whether this actually fired on a given run. Movable LINE walls (thin
dividers, the perimeter) are excluded from all of this — a polyline's
bounding box is the room it encloses, not a footprint another element
could plausibly stack on.

## Bridging two schemas

`optimizer/` was built somewhat independently of this app's editor and
initially used an older venue-format convention. Two gaps were closed so
it works on venues actually drawn in the editor, not just its own
synthetic training fixtures:

- **Point rate field name**: the editor calls it `throughput`; `sim.py`/
  `arena.py` read `flowRate`. `arena._throughput(p)` now reads either,
  preferring `throughput` (matching the editor's own on-load migration).
- **Zone occupancy**: `sim.py`/`arena.py` classify a zone as a crowd
  source via explicit `capacity`/`stickiness` fields the current editor
  schema doesn't have (it only carries a boolean `attraction`). A zone
  now also counts as populated if it's `attraction: true` or a `seating`
  zone, with capacity derived from its drawn floor area at a
  comfortably-occupied density (`arena._zone_capacity`/
  `_zone_stickiness`) when the file doesn't specify one explicitly (this
  project's own synthetic training venues, from `sample_venue.py`, do).

## Performance

The Crowd Simulation panel's **Training samples** field (default 100,
clamped in `src/main/main.js`'s `optimizer:run` handler to [20, 1000] so a
stray value can't hang the app on an absurdly long run) sets
`CROWDSENSE_N`, the number of simulator-scored samples `run_pipeline.py`
generates before training the surrogate and searching — the step that
dominates wall-clock time. 100 took ~40s on an 18-core machine in testing;
lower it for a quicker, rougher search while iterating on a layout, or
raise it for a more thorough one before committing to a result. The
script's own CLI default (used only when run directly from a terminal,
outside the editor) is 420 — tuned for a thorough offline run, several
minutes — since a terminal invocation isn't paying for interactivity the
way a click in the editor is.

## What you see

If the winning candidate didn't beat the current layout, a dialog says so
and nothing changes. Otherwise, a dialog reports the weighted cost
before/after and the per-scenario breakdown, and offers to load the
winning layout into the editor (replacing the current one — Undo still
works). The full result, including every scenario's individual metrics
(T95, peak density, danger fraction) before and after, is also written to
`optimizer/data/optimize-runs/run-<timestamp>/optimized-venue.json`
under that file's own top-level `simulation` key.
