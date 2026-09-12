# CrowdSense — project brief for Claude Code

Read this whole file before doing anything. This is a live hackathon
project (HackCMU) with a hard deadline. Sameer owns the optimization/ML
side; teammates own the venue editor (done) and the physics simulator
(not yet built).

## What this project is

Model crowd flow in a venue as a continuum (Navier-Stokes-flavoured, not
literal water), then optimize the venue's LAYOUT to reduce evacuation time
and crush-injury risk (crowd pressure). "Optimize the layout" means:
reposition the movable furniture/walls/zones inside a FIXED building shell
— not design a building from scratch.

## Repo layout — what's real vs. placeholder

```
src/, docs/, examples/, README.md   <- teammates' work. DONE. Don't touch
                                        without asking. This is an Electron
                                        desktop app for drawing venues to
                                        scale and exporting .crowdsense.json.
                                        docs/VENUE_FORMAT.md is the spec —
                                        READ IT before touching any venue
                                        JSON, it answers most format questions.

optimizer/
  arena.py            <- loads a venue JSON, scores a layout. THE SCORING
                          FUNCTION (score/objective) IS A PLACEHOLDER —
                          geometric Dijkstra + flow accumulation, not real
                          physics. Swap it for the team's simulator the
                          moment it exists; nothing else changes.
  surrogate.py         <- a small hand-written numpy MLP (no torch by
                          choice, see "Working conventions" below) that
                          imitates arena.py's objective(), plus gradient
                          descent through the frozen network to search for
                          better layouts.
  run_pipeline.py      <- the whole loop: generate data -> train surrogate
                          -> optimize -> VALIDATE ON THE REAL SCORER, WITH
                          A FALLBACK IF THE SURROGATE FOOLED THE SEARCH.
                          Run this to see the whole thing work end to end.
  show_pipeline.py     <- renders optimizer/club_before_after.png (floor
                          plan before/after, red = crowd pressure overlay).
  legacy_gate_model/   <- an EARLIER, WRONG assumption (that venues have
                          multiple staffed gates to choose from). The real
                          venue format has one entrance + one emergency
                          exit, both fixed, and the real lever is movable
                          walls/zones. Kept for reference only. Do not
                          build on these files.
```

## Run it right now to confirm the environment works

```bash
cd optimizer
source ../.venv/bin/activate    # already has numpy + matplotlib installed
python3 run_pipeline.py
python3 show_pipeline.py
```

Expect: ~900 simulated layouts generated, a surrogate trained (prints
"held-out rank corr." — should be > 0.85), a search result, and
`optimized-venue.json` + `club_before_after.png` written to `optimizer/`.

## Known bugs already fixed — do not reintroduce

- `points[].flowRate` in the venue format is **people PER MINUTE**, not per
  second. `arena.py`'s `_rasterize()` divides by 60 before using it as a
  queue rate. If evacuation times ever look suspiciously fast (single-digit
  seconds for hundreds of people), this is the first thing to check.
- Always validate an "optimized" layout against `score()`/`objective()`
  (the real scorer), never trust `surrogate.predict()` directly. See the
  safety-net block near the bottom of `run_pipeline.py` — it falls back to
  the best randomly-sampled layout if the surrogate's pick doesn't actually
  beat the original.

## What's NOT done yet — pick from here

In roughly the order that matters most tonight:

1. **The real simulator doesn't exist yet.** `arena.py`'s `score()` is a
   geometric stand-in (Dijkstra shortest-path + flow accumulation on a
   raster grid), not Navier-Stokes / continuum crowd dynamics. Find out
   from teammates whether/when a real simulator is coming. If it lands,
   the ONLY change needed is: make `objective(venue, u)` call it instead.
   Everything else (surrogate, search, validation, viz) stays as-is.

2. **`arena.py`'s pack/unpack is hardcoded to ONE example venue.** It knows
   about `zone_pit`, `zone_bar`, `wall_riser_1`, `wall_divider` by ID. It
   will crash or silently do nothing sensible on any other `.crowdsense.json`.
   The correct generalization: walk `venue["walls"]` and `venue["zones"]`,
   collect every element with `movable: true`, and build the parameter
   vector dynamically (position always; width/height too if `extendable:
   true`). Bounds should default to "stay inside the room's bounding box,
   don't overlap other movable elements" rather than the current
   hand-tuned left/right split. This is the single highest-value piece of
   remaining work — it's what makes the pipeline actually usable on a venue
   someone draws in the editor tonight, not just the one fixture.

3. **Only rect shapes are handled.** The format also allows `circle` and
   `polygon` zones. Not urgent unless a teammate draws a venue using them.

4. **`arena.py` doesn't use `stickiness`** (avg. dwell minutes per zone) —
   currently every person in a zone is assumed to walk straight for an
   exit. Real crowds linger at a bar/merch table before heading out. Could
   inflate a zone's effective evac contribution by its stickiness; not
   attempted yet.

5. **CMA-ES / black-box optimizer as a second search method**, to cross-
   check the surrogate-gradient-descent result. Cheap to add
   (`pip install cma`), good insurance if gradient search gets stuck.

## Working conventions

- Don't touch `src/`, `docs/`, `examples/`, or the root `README.md` without
  checking with Sameer first — that's the other half of the team's surface
  area and it's finished.
- Results get written into a full venue-shaped JSON under a new top-level
  `"simulation"` key (see `write_result()` in `arena.py`) — this matches
  the format spec's promise that unrecognized top-level keys survive a
  round-trip through the editor. Don't invent a different output shape.
- The venv at repo root (`.venv/`) already has `numpy` + `matplotlib`.
  Activate it (`source .venv/bin/activate` from repo root) before running
  anything — don't install packages globally.
- The surrogate is hand-written numpy rather than PyTorch/etc. by choice —
  at 14 inputs a framework buys nothing, and it keeps the dependency list
  at just numpy + matplotlib. If you want to switch to a real framework,
  that's fine, just confirm `pip install torch` actually completes on this
  machine first (it timed out in the sandbox this was originally built in;
  may or may not be an issue on Sameer's Mac).

## First thing to do when you start

1. Run the pipeline (commands above) to confirm your environment matches
   what's described here.
2. Ask Sameer whether teammates have a working simulator yet, or an ETA.
3. Start on item #2 in "what's not done yet" (generalizing pack/unpack) —
   it's valuable regardless of what happens with the real simulator, and
   it's the thing most likely to break if anyone draws a new venue tonight.
