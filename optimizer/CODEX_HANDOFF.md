# Handoff — CrowdSense optimizer/ML track

Written 2026-09-11, end of a long Claude Code session, for whoever (Codex or
a human) picks this up next. Read this whole file before touching anything.
It assumes you also have access to the two source documents this entire
track is built from — find them and read them first if you don't already
have them open:

- `~/Downloads/CrowdFlow_design_document.docx` — "Crowd-Flow Design
  Document v0.1". Decisions D1-D7: the simulator IS a corrected Hughes
  continuum model (not Navier-Stokes, not agents), with a specific speed
  law, grid, and metrics. §4 is the simulator spec, §4.10 is its test
  suite, §5 is the data factory spec, §6 is the surrogate/optimizer stack,
  §7 is what you may and may not claim to judges.
- `~/Downloads/Hackathon (1).docx` — the cost function: excess-magnitude
  density penalty over a safety threshold, plus its softplus relaxation.

Everything below implements those two documents plus a series of
corrections the user made mid-session (see "Deliberate deviations from the
design doc" below) — it is not a guess at what they wanted, it is what they
explicitly asked for, adjusted as bugs were found.

## Run this first

```bash
cd optimizer
source ../.venv/bin/activate
python3 -m pip install numpy matplotlib torch   # if imports fail, see gotcha below
python3 test_sim.py                              # 5/5 must PASS, ~6s
python3 validate_venue.py ../examples/sample-venue.json venues/generated/*.json venues/from_gemini/*.json
python3 run_unet_pipeline.py                     # full loop, ~4 min if data/shard_000.npz exists
```

**Environment gotcha, cost real time once already**: this Mac's shell
aliases `pip` to Homebrew's python3.11, NOT the project's `.venv` (which is
python3.14). `pip list` inside the activated venv shows the WRONG
interpreter's packages and will make an empty venv look populated. Always
use `python3 -m pip ...` inside `.venv`. `scikit-fmm` will not build on
python3.14 — that's why `sim.py` has its own fast-marching solver.

## What exists, file by file

- **`sim.py`** — the simulator. Corrected Hughes continuum: Weidmann speed
  law (`speed()`), a hand-written fast-marching eikonal solver (`eikonal()`,
  since scikit-fmm doesn't install here), multi-class finite-volume upwind
  transport (`run()` — one density class per DESTINATION, so different
  people can be walking to different places through shared congestion at
  once). Four scenarios (`make_scenario()`): evacuation, ingress, headliner
  (surge to the stage), circulation (table-to-table with dwelling, the
  "normal operation of a fair/venue" case). Incidents (`incident=` on
  `run()`) place an attractor or blockage at ANY coordinate, at any time.
  `appraise()` computes cost: **a single variable, density** (see "Cost
  function" below) — this is a deliberate, explicit simplification, don't
  reintroduce blended terms without being asked.
- **`test_sim.py`** — design doc §4.10 tests + circulation + incident
  coverage. RUN THIS AFTER EVERY EDIT TO `sim.py`. 5/5 must pass. The drain
  test checks T95 against an ANALYTIC answer (182.7s), not a vibe.
- **`arena.py`** — venue JSON ↔ layout-vector conversion. Fully general:
  walks `walls`/`zones`/`points`, packs every `movable: true` element
  (position always, size too if `extendable`), any shape
  (rect/circle/line/polygon), bounds = inside the fixed building shell
  (`_shell_bounds`, NOT the padded raster extent — that was a real bug,
  see below), soft overlap resolution between movable furniture.
  `simulate()`/`objective()` run a venue+layout through `sim.py` over a
  scenario suite and return the density-based cost. `SCENARIO_HORIZONS` is
  the SINGLE SOURCE OF TRUTH for how long each scenario runs — both
  `training_suite()` and `default_suite()` read from it. **Do not let this
  drift into two different numbers again** (see "Bugs found and fixed",
  the horizon-mismatch entry — it silently invalidated every search
  candidate for an entire session until traced).
- **`unet.py`** — the U-Net surrogate (design doc §6.2) and the
  differentiable path through it (§6.3). `Raster` draws every movable
  element with SOFT (sigmoid) edges so gradients reach the ~15-number
  layout vector, not pixels — verified to agree with the real rasterizer
  99.0% on walkability. `UNet`: 4 levels, base=16, 1.98M params (matches
  the doc's ~2M target — base=32 gives 7.8M and overfits ~1800 samples).
  `surrogate_cost()` computes cost from the net's OWN predicted density
  map (not a separately regressed scalar) — the search descends through
  density end to end, matching the "cost is a function of density alone"
  simplification.
- **`factory.py`** — data generation (design doc §5). Runs the REAL
  simulator (not the surrogate) across sampled layouts × scenarios,
  multiprocessed, workers import only `arena`/`sim` (never `torch` — that
  would be dragged into every worker process pointlessly). `_drop_invalid`
  enforces the design doc's own rule: "if clipped mass exceeds 1% of N_in,
  the run is invalid" — drop it from training data, don't silently keep it.
- **`run_unet_pipeline.py`** — the full loop: load `data/shard_000.npz` →
  train U-Net → §6.3 gradient search (24 random starts) → **re-simulate
  every candidate on the real simulator** → rank ONLY candidates that pass
  the same 1%-clipped / not-disconnected validity bar → report. Never
  ships a candidate that fails validity even if its cost number looks
  better — see `_verify()`'s `valid` flag and the ranking key
  `(not valid, cost)`.
- **`show_pipeline.py`** — the demo figure: 3 scenarios × before/after,
  peak-density heatmap with a ρ_safe contour line.
- **`show_unet.py`** — simulator's density map vs. the U-Net's predicted
  one vs. the error, on a held-out layout. The slide that proves the
  surrogate learned physics, not a mean.
- **`sample_venue.py`** — procedural venue generation (design doc §5's
  three archetypes: rectangular hall, corridor-into-hall, hall-with-
  obstacles). `venues/generated/` holds output.
- **`validate_venue.py`** — the actual proof that generalization works on
  a venue this code has never seen. Two layers: schema check, then RUNS
  the real pipeline (`arena.build_spec` → `arena.unpack` → containment
  check → round-trip check → `sim.Venue` → a short `sim.run` per scenario
  → ledger/clipping/NaN checks). 9/9 procedural venues pass; 5/5 real
  venues (see below) pass.
- **`venues/from_gemini/`** — 5 REAL venues (a golf clubhouse, a barrel
  room, a community center, two ballrooms) extracted by Gemini from
  publicly posted booking/listing PDFs, converted to the venue JSON
  schema. All 5 pass `validate_venue.py` clean (0% clipped, ledger error
  at machine epsilon, zero disconnections). This is the actual evidence
  for "generalizes to venues it's never seen," and it's in the repo, not
  just asserted.
- **Density-model registry, in `sim.py`** — `DENSITY_MODELS` dict +
  `@register_density_model("name")` decorator. Two entries exist right
  now:
  - `"simulated_peak"` (= `DENSITY_MODEL`, the active default): the real
    simulator's max-over-time density map. Exact, expensive (~1-6s/call).
  - `"flux_inversion"`: a fast, closed-form, steady-state estimate — solve
    the eikonal route field once, accumulate flux along it, invert the
    Weidmann fundamental diagram pointwise to get the density that flux
    implies, iterate a few times to a fixed point (routing depends on
    congestion, congestion depends on routing). Plus a static "occupancy"
    term for people already arrived and dwelling (this was NOT in the
    first version and its absence was the whole story — see "Bugs found").
    **Validated**: r=0.975 correlation with the real simulator on
    `circulation` (its intended use case — steady ongoing conditions), at
    a 104x speedup. r=0.27-0.29 on `evacuation`/`headliner`, which is
    EXPECTED and documented, not a bug — those scenarios have no true
    steady state (a draining population, not a standing flow), and the
    function says so in its own docstring. Use `simulated_peak` as ground
    truth for those two; `flux_inversion` is a fast cross-check, not a
    replacement, there.

  This is the slot your teammates' equation plugs into:
  `@register_density_model("their_name") def their_fn(vg, cfg, result=None): ...`
  registers it; `arena.simulate(..., density_model=sim.DENSITY_MODELS["their_name"])`
  or `sim.DENSITY_MODEL = sim.DENSITY_MODELS["their_name"]` switches to it.
  Nothing else changes — `cost_from_density()`, `appraise()`, the U-Net
  training loop, and `run_unet_pipeline.py` all read whatever map comes
  back from the active model with zero other edits required.

## Cost function — READ BEFORE CHANGING

The user explicitly asked, twice, for the cost to be **a function of ONE
variable: density**, and no other business logic blended in. `sim.appraise()`
implements exactly that: `cost = cost_from_density(peak_density_map)`,
nothing else summed in. T95, danger area, pressure proxy, disconnection,
capacity fit are all still computed and returned (design doc §4.9 wants
them reported), they just don't feed `cost`. `sim.is_valid(terms)` is a
SEPARATE hard gate (not folded into `cost`) for rejecting disconnected or
overcapacity layouts before ranking — do not merge that back into `cost`
either; that was tried and explicitly reverted by request.

Known, accepted tradeoff of this purity (documented in `appraise()`'s own
docstring, not hidden): a small, low-density pocket of permanently
disconnected people won't raise `cost` if it never crosses ρ_safe. That's
why `is_valid()` exists as a separate check — use both together.

## Bugs found and fixed this session (do not reintroduce)

1. Plain upwind transport pushed mass into already-jammed cells; the
   `RHO_MAX` clamp deleted 34% of a crowd. Fixed with iterated
   supply-limiting (`SUPPLY_PASSES`, runs to convergence, not a fixed
   count — a fixed 2 passes still lost half the crowd).
2. A point rasterized to one 0.5m grid cell = a 0.5m door, fabricating a
   crush at every entrance/exit regardless of how it was drawn. Fixed:
   doors get width from `flowRate` (people/min ÷ `C_EXIT`), clamped to
   [1, 6]m.
3. `arena.py`'s containment bounds used the padded RASTER extent, letting
   the optimizer park furniture outside the actual building shell. Fixed:
   `_shell_bounds()` computes bounds from the fixed (non-movable) walls.
4. A line wall's bounding box is the space it ENCLOSES (the perimeter
   wall's bbox is the whole room) — treating it as solid shoved every
   movable element off the floor in overlap resolution. Fixed: line walls
   excluded from collision boxes; zones only repel other zones (they're
   AREAS and may legitimately contain a column), solids only repel solids.
5. Entrances admitted new people for an entire circulation run with no cap
   tied to the venue's actual drawn capacity — one random layout hit 999
   people in a room sized for 520, clipping 34.7%. Fixed: admission capped
   at (venue's total zone capacity − current occupancy).
6. **The training/verification horizon mismatch** — `training_suite()` and
   `default_suite()` used DIFFERENT horizons per scenario (240/420/180s vs
   300/600/300s). The U-Net was trained on one physical quantity (density
   accumulated over 240s of circulation) and verified against another
   (300s). This silently made EVERY §6.3 search candidate fail the 1%
   validity bar for a full session before it was traced. Fixed:
   `arena.SCENARIO_HORIZONS` is now the only place these numbers live;
   both suites, and `factory.py`, read from it. **If you ever see "every
   candidate is invalid" again, check this first** before assuming the
   physics is broken.
7. `flux_inversion_density`'s first version modeled only people IN
   TRANSIT, correlating r=0.045 with the real simulator on `circulation`
   — because most of that scenario's density is people who already
   arrived and are standing still (dwelling), not corridor traffic. Fixed
   by adding `_occupancy_density()`, the same static zone-filling the
   dynamic sim uses at t=0. Correlation went to r=0.975.

## Known, NOT-yet-fixed issues (real, diagnosed, left for you)

1. **The dwelling-release mass leak** (`sim.py`, search `KNOWN ISSUE` — two
   comments, one in the transition-release code, one at the final
   clamp). Root cause: when someone finishes a dwell period and the
   transition matrix says "stay at the same zone" (a real, common case —
   people at a merch table mostly keep browsing), the code currently
   routes that share back out through `rho` (walking density) before it
   resettles into `dwell`, which re-injects mass into the SAME
   already-near-capacity cells every step, bypassing the transport step's
   supply-limiter (that only throttles flux BETWEEN cells, not this direct
   local injection). Measured impact: ~1-3.4% of a crowd clipped on some
   layouts' `circulation` scenario over a long horizon.
   - **A naive fix was tried and made it WORSE** (6.3% clipped, not
     better): keeping the "stay" share directly in `dwell` instead of
     routing it through `rho` skips the existing `TAU_ARRIVE` gradual
     re-settling, which was accidentally smoothing the reinjection. Do
     not just re-apply that fix; it needs the smoothing effect preserved
     while removing the "walk through your own footprint" bug.
   - **The real fix**, per the note at the final clamp: replace the
     scale-down-and-delete clamp with a `_spread()`-style overflow-relief
     pass — push excess density to a neighbouring cell that has room,
     the way a real crowd gets shoved sideways instead of vanishing. It
     MUST be fully vectorized (no per-cell Python loop): this runs every
     one of ~3000 timesteps, in every scenario call, hundreds of times
     during factory generation. A Python loop here would make the factory
     run impractically slow.
   - Current mitigation: `factory.py`'s `_drop_invalid` filters training
     samples over 1% clipped; `run_unet_pipeline.py`'s validity gate does
     the same for search candidates. The pipeline is honest about this
     (reports it, doesn't hide it), just not yet fixed at the root.
2. **Zone-vs-zone overlap is soft, not hard.** An oversized `extendable`
   zone can still overlap another zone in roughly a quarter of random
   layouts (the density cost punishes the resulting overcrowding, it
   doesn't forbid the geometry). Not urgent — the cost function already
   discourages it — but a hard packing constraint would close it cleanly.
3. **Polygon-shaped obstacles use a bounding-box approximation** in the
   raster (`_build_obstacle`). Fine until someone draws a non-rectangular
   stage or restricted zone.
4. **`flux_inversion_density`'s bottleneck handling is flat**: an
   over-capacity cell is stamped `RHO_MAX` rather than propagating a
   realistic backed-up queue upstream. This is explicitly left as the next
   density-model idea to layer on top (see its own docstring) — a
   queueing/backpressure pass over the same flux field, walking upstream
   from each jammed cell.
5. **`flux_inversion_density`'s evacuation/headliner rate is a labeled
   approximation** (`total_population / T_REF`), because those scenarios
   have no true steady state (a draining population, not standing flow).
   Correlates only r=0.27-0.29 with the real sim there — expected, stated
   in the docstring, not silently wrong. Use `simulated_peak` as ground
   truth for those two scenarios.
6. **Only one venue (`examples/sample-venue.json`) has an actual trained
   U-Net + verified search result.** The generalization claim (validated
   on 9 procedural + 5 real venues) is about the PIPELINE running clean
   end-to-end, not about having optimized all 14 of them. Running
   `factory.py --venue <path>` + `run_unet_pipeline.py` (needs a
   `--venue` flag added — currently hardcoded to the sample fixture) on a
   second venue would be the next concrete demo strengthener.

## Deliberate deviations from the design doc (not oversights)

- **Cost is density-only** (see above), not the doc's own
  `J = (1,3,3)·(T95/T_ref, A_danger/A, maxP/P*)` blend. That blend was
  tried first and found to be ~99% a pressure-only objective in disguise
  (`maxP/P* ≈ 130` vs. `≈1` for the other terms) — this is documented in
  `sim.py` git history / comments, not silently dropped.
- **Multi-class transport** (one density field per destination) instead
  of the doc's single-class Hughes model — needed to express circulation
  (table-to-table), incidents, and evacuation as the SAME engine rather
  than three separate codebases. The doc's equations (speed law, upwind
  scheme, ledger) are followed exactly per class; only the "how many
  classes" choice is an extension.
- **Optimization variables are continuous layout positions/sizes**
  (movable walls/zones from the venue editor), not the design doc's D3
  fixed-cell operational toggles (gate open/closed, barrier deployed).
  This matches CLAUDE.md's own framing (movable furniture inside a fixed
  shell) which predates and supersedes D3 for this project. `unet.py`'s
  `Raster` class exists specifically because continuous variables need a
  genuinely differentiable rasterizer that the doc's toggle-based D3
  didn't need to build.
- **No scikit-fmm** (see environment gotcha) — `sim.eikonal()` is a
  hand-written Godunov-upwind fast marching solver, verified against the
  design doc's own fundamental-diagram number (q peaks at 1.225 people/m/s
  at ρ=1.75/m²; doc says 1.22 at 1.75).

## If you're picking this up cold, do this in order

1. `python3 test_sim.py` — confirm the environment and physics still hold.
2. `python3 validate_venue.py ../examples/sample-venue.json venues/generated/*.json venues/from_gemini/*.json` — confirm generalization still holds (14/14 should pass).
3. Read `sim.appraise()`'s docstring and `sim.DENSITY_MODELS` — understand
   the cost contract before changing anything near it.
4. If continuing on the density-map hook: your teammates' equation
   registers via `@sim.register_density_model("name")`, signature
   `(vg, cfg, result=None) -> np.ndarray[H, W]`. Test it the same way
   `flux_inversion_density` was tested — correlation against
   `simulated_peak` on a short horizon, per scenario, before trusting it.
5. If continuing on the dwelling-release leak: start from the two `KNOWN
   ISSUE` comments in `sim.py`, and benchmark any fix against
   `python3 test_sim.py`'s circulation test AND a re-run of
   `run_unet_pipeline.py`'s validity rate (how many of the 4 search
   candidates pass the 1% bar) — that's the real regression signal.
