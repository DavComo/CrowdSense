# CrowdSense — project brief for Claude Code

Read this whole file before doing anything. Live hackathon project (HackCMU),
hard deadline. Sameer owns the optimization/ML side; teammates own the venue
editor (done) and are writing a density-map equation (see below).

## What this project is

Model crowd flow in a venue as a continuum, then optimize the venue's LAYOUT
so the crowd is safer — not just in an evacuation but in NORMAL OPERATION:
people moving table to table at a fair, a headliner walking on stage, an
incident breaking out at an arbitrary spot on the floor. "Optimize the
layout" means: reposition movable furniture/walls/zones inside a FIXED
building shell — not design a building from scratch.

The physics and the objective come from two documents Sameer supplied (both
in `~/Downloads/`, extract text with `zipfile`, no python-docx):

- **`CrowdFlow_design_document.docx`** — the simulator spec. D1: corrected
  HUGHES CONTINUUM (density-driven, eikonal route field, no momentum
  equation) — NOT Navier-Stokes (incompressible can't jam, App. A.1), NOT
  agents. Weidmann speed law. §4.10 verification tests. §7: never say
  "injury"/"deaths"/"safe capacity" — say "exploratory continuum simulation".
- **`Hackathon (1).docx`** — the cost function: excess-magnitude density
  penalty `Σ max(0, ρ−ρ_safe)^p·ΔA·Δt` and its softplus relaxation.

## Repo layout — what's real

```
src/, docs/, examples/, README.md   <- teammates' work. DONE. Don't touch
                                        without asking. docs/VENUE_FORMAT.md
                                        is the venue JSON spec.

optimizer/
  sim.py               <- THE SIMULATOR. Hughes continuum: Weidmann f(ρ), own
                          fast-marching eikonal solver (scikit-fmm won't
                          build here), MULTI-CLASS transport (one density
                          field per DESTINATION, so evacuation/circulation/
                          headliner-surge/incidents-anywhere are one engine).
                          Scenarios: evacuation, ingress, headliner,
                          circulation (table-to-table, zones[].stickiness for
                          dwell). Incidents (attractor or blockage) placeable
                          at any coordinate, any time. `appraise()`: cost is
                          ONE variable, density (see below) -- `is_valid()`
                          is a separate hard gate, not folded into cost.
                          `DENSITY_MODELS` registry -- see the hook section.
  test_sim.py          <- design doc §4.10 + circulation + incident tests.
                          RUN AFTER EVERY sim.py EDIT. 5/5 must pass.
  arena.py             <- venue JSON <-> layout vector. GENERAL: any venue,
                          any shape (rect/circle/line/polygon, properly
                          rasterized, not bbox-approximated), bounds = inside
                          the fixed shell, overlap resolution between movable
                          furniture. `SCENARIO_HORIZONS` is the ONE place
                          scenario run-lengths live -- training_suite() and
                          default_suite() both read it; never let these
                          drift into two different numbers again (see bugs).
                          simulate()/objective() run sim.py over a suite.
  unet.py              <- U-Net surrogate (design doc §6.2) + the
                          differentiable path through it (§6.3). `Raster`
                          draws movable elements with soft (sigmoid) edges so
                          gradients reach the ~15-number layout vector, not
                          pixels (verified 99% agreement with the real
                          rasterizer). `surrogate_cost()` computes cost from
                          the net's OWN predicted density map end to end.
  factory.py           <- data generation (§5), multiprocessed, real
                          simulator, enforces the design doc's own "drop if
                          >1% clipped" validity rule on training data.
  run_unet_pipeline.py <- train -> §6.3 gradient search (24 starts) ->
                          RE-SIMULATE every candidate -> rank ONLY candidates
                          that pass the 1%-clipped/not-disconnected validity
                          bar -> report. `python3 factory.py --n 700` first.
  show_pipeline.py     <- before/after figure, 3 scenarios, peak-density
                          heatmap with a ρ_safe contour.
  show_unet.py         <- U-Net's predicted density map vs. the simulator's,
                          on a held-out layout.
  sample_venue.py      <- procedural venue generation (§5's 3 archetypes) ->
                          venues/generated/.
  validate_venue.py    <- proof of generalization: schema check, THEN
                          actually runs the pipeline (pack/unpack, bounds,
                          round-trip, sim.Venue, a short sim.run per
                          scenario) on any venue file. 16/16 pass: the
                          sample fixture, 9 procedural venues, 5 REAL venues
                          (venues/from_gemini/ — a golf clubhouse, a barrel
                          room, a community center, two ballrooms, sourced
                          from public booking PDFs), 1 circle/polygon
                          regression test.
  legacy_gate_model/   <- an EARLIER, WRONG assumption. Reference only.
```

## Run it right now

```bash
cd optimizer
source ../.venv/bin/activate
python3 -m pip install numpy matplotlib torch   # if imports fail, see gotcha
python3 test_sim.py                              # 5/5 PASS, ~6s
python3 validate_venue.py ../examples/sample-venue.json venues/generated/*.json venues/from_gemini/*.json
python3 factory.py --n 700          # ~10 min, writes data/shard_000.npz
python3 run_unet_pipeline.py        # train + search + verify, ~2-4 min
python3 show_pipeline.py
```

**ENVIRONMENT GOTCHA:** the shell aliases `pip` to Homebrew's python3.11 —
`pip list` inside the venv shows the WRONG interpreter's packages. The venv
is python3.14. Always `python3 -m pip ...`.

## The density-map hook — teammates plug in HERE

`sim.DENSITY_MODELS` is a REGISTRY, not one hardcoded function:

```python
@sim.register_density_model("their_name")
def their_equation(vg, cfg, result=None) -> np.ndarray[H, W]:   # people/m²
    maps = sim.input_maps(vg, cfg)   # walkable, initial_density, targets[k],
                                     # entrance_rate, exit_mask, attractor_draw
    ...
# switch the active default, or pass it explicitly per call:
sim.DENSITY_MODEL = sim.DENSITY_MODELS["their_name"]
arena.simulate(venue, u, spec, density_model=sim.DENSITY_MODELS["their_name"])
```

Two entries exist now: `"simulated_peak"` (default — the real simulator's
max-over-time map, exact but slow) and `"flux_inversion"` (built tonight —
solve the route field once, accumulate steady-state flux, invert the
Weidmann fundamental diagram pointwise, no time-stepping. **Validated:
r=0.975 correlation with the real simulator on `circulation` at 104x
speedup**; correctly weak (r≈0.28) on evacuation/headliner, which have no
true steady state — documented in its own docstring, not silently wrong).
`cost_from_density()` applies the Hackathon penalty to whatever map comes
back; nothing else changes when the active model changes.

## Cost function — read before changing

Cost is **one variable: density**, per explicit instruction (twice). `cost
= cost_from_density(peak_density_map)`. T95, danger area, pressure,
disconnection are all still computed and reported (design doc §4.9), they
just don't feed `cost`. `sim.is_valid(terms)` is a SEPARATE hard gate for
disconnected/overcapacity layouts — do not fold it back into `cost`.

## Known bugs found and fixed — do not reintroduce

- `points[].flowRate` is people PER MINUTE. `sim.py` divides by 60.
- Never trust a surrogate's number. Every search candidate is re-simulated
  on the full suite; only one passing the validity bar ships
  (`run_unet_pipeline.py`'s `_verify()`).
- Plain upwind pushed mass into jammed cells; the RHO_MAX clamp deleted 34%
  of a crowd. Fixed: iterated supply-limiting (`SUPPLY_PASSES`, runs to
  convergence, not a fixed count).
- A point rasterized to one 0.5m cell = a 0.5m door, faking a crush at
  every doorway. Fixed: doors get width from `flowRate`.
- Containment used the padded raster bbox, letting the optimizer park
  furniture outside the perimeter. Fixed: `_shell_bounds()`.
- A line wall's bbox is the room it ENCLOSES, not a solid block — was
  shoving every movable element off the floor. Fixed: line walls excluded
  from collision boxes; zones only repel zones, solids only repel solids.
- Entrances admitted people all run long with no cap tied to the venue's
  drawn capacity. Fixed: capped at (total zone capacity − current
  occupancy).
- **Training and verification used DIFFERENT horizons per scenario**
  (240/420/180s vs 300/600/300s) — the U-Net was trained on one physical
  quantity and verified against another, silently failing every search
  candidate's validity check for a full session before it was traced.
  Fixed: `arena.SCENARIO_HORIZONS` is the only place these numbers live now.
- **Entrance admission distributed evenly across a door's cells regardless
  of which ones actually had room** — the aggregate `door_room` check was
  correct, but splitting `admit` uniformly could overflow one crowded cell
  even though the sum across the door was fine. This was the actual source
  of circulation's occasional >1% clipped mass (traced by instrumenting
  every phase of `run()` on a failing case — it only ever appeared right
  after entrance admission, never after transport/arrivals/dwelling).
  Fixed: allocate proportional to each cell's own remaining room
  (`amount_to_c = admit * room_per_cell[c] / total_room`, which
  mathematically cannot exceed `room_per_cell[c]`). Result: 3.4% clipped →
  0.0% on the traced case.
- **Circle and polygon shapes were rasterized as their bounding box**, not
  their actual shape — a round column blocked its full bounding square
  (denying a walkable corner nobody was standing in), a triangular stage
  did the same. Fixed: `mark_circle()` (disc test) and `mark_polygon()`
  (vectorized even-odd ray-casting) in `_build_obstacle`; same fix applied
  to `_geo_interior_cells` (population placement inside circle/polygon
  zones). Verified directly: a pillar's bbox corner and a triangle's bbox
  corner are now correctly walkable. Regression test added:
  `venues/generated/polygon_circle_test.crowdsense.json`.
- **Zone-vs-zone overlap resolution failed ~18.5% of random layouts** —
  pure translation can't separate two zones when the room is too small for
  both at their current (possibly `extendable`-grown) size; pushing one
  away just walked it into a wall and the containment clamp walked it
  right back. Fixed: a fallback pass that shrinks the smaller box along
  the less-overlapped axis (floored at 1m) when translation alone can't
  resolve it. Down to ~5% residual (harder multi-zone cases) — see below.
- The design doc's `J = (1,3,3)·(T95/T_ref, A_danger/A, maxP/P*)` blend is
  ~99% a pressure-only objective in disguise (`maxP/P*≈130` vs `≈1` for the
  rest). Replaced with the pure density cost above.
- `flux_inversion_density`'s first version modeled only people IN TRANSIT,
  correlating r=0.045 with the real simulator on `circulation` — most of
  that scenario's density is people already arrived and standing still
  (dwelling), not corridor traffic. Fixed by adding `_occupancy_density()`
  (same static zone-filling the dynamic sim uses at t=0). Correlation →
  r=0.975.

## Known, NOT-yet-fixed issues

1. **Zone-vs-zone overlap, residual ~5%.** The shrink fallback handles most
   cases; a few (near-`MIN_DIM`, or 3+ mutually overlapping zones) can
   still slip through. The density cost already discourages the resulting
   overcrowding; a hard packing solver would close the rest.
2. **`flux_inversion_density`'s bottleneck handling is flat** — an
   over-capacity cell is stamped RHO_MAX rather than propagating a
   realistic queue upstream. Explicitly left open (see its own docstring)
   as the next density-model idea: a queueing/backpressure pass over the
   same flux field.
3. **`flux_inversion_density` on evacuation/headliner uses a labeled
   approximation** (`population / T_REF`) since those scenarios have no
   true steady state. Use `"simulated_peak"` as ground truth there.
4. **`_geo_ring_cells` (queueing rings for hotspot/entrance-surge targets)
   still uses a bbox approximation** for circle/polygon zones — lower
   priority than the interior-cells fix above since it only affects
   routing TARGET placement for oddly-shaped stages, not where population
   actually stands.
5. Only `examples/sample-venue.json` has a trained U-Net + verified search
   result. The generalization claim (16/16 `validate_venue.py`) is about
   the pipeline running clean everywhere, not about having optimized all
   of them — running `factory.py`/`run_unet_pipeline.py` against a second
   venue (needs a `--venue` flag added, currently hardcoded) is the next
   concrete demo strengthener.

## Working conventions

- Don't touch `src/`, `docs/`, `examples/`, or the root `README.md` without
  checking with Sameer first.
- Results go into a full venue-shaped JSON under a top-level `"simulation"`
  key (`arena.write_sim_result()`). Don't invent another shape.
- Dependencies are numpy + matplotlib + torch, on purpose — the eikonal
  solver and everything else in `sim.py`/`arena.py` is hand-written so
  nothing but the U-Net needs to build on py3.14.
- Say "exploratory continuum simulation" / "modeled congestion". Never
  "injury", "deaths", "safe capacity", "certified" (design doc §7).
- After ANY change to `sim.py` or `arena.py`: run `test_sim.py` (5/5) AND
  `validate_venue.py ../examples/sample-venue.json venues/generated/*.json
  venues/from_gemini/*.json` (16/16) before considering it done.
