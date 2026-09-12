"""
validate_venue.py -- does this venue (procedurally generated, hand-drawn, or
extracted from a real floor plan by Gemini) actually work with our pipeline?

Two layers, in order -- a schema check first because it gives a much clearer
error than a stack trace three modules deep, then the real proof:

  1. SCHEMA -- required keys/fields present, per docs/VENUE_FORMAT.md, with
     a specific complaint (missing field, wrong shape name) rather than a
     KeyError from inside arena.py.
  2. PIPELINE -- actually run it: arena.build_spec (does pack/unpack find
     movable elements and stay off the walls?), sim.Venue (does it rasterize
     to a sane grid?), and one short sim.run per scenario (does the physics
     converge without the ledger blowing up?). This is the part that proves
     the generalization work is real and not just tested against the one
     fixture it was written against.

    python3 validate_venue.py path/to/venue.crowdsense.json [more.json ...]
    python3 validate_venue.py venues/generated/*.json
"""

import argparse
import glob
import sys

import numpy as np

import arena
import sim

REQUIRED_TOP = ("version", "meta", "scale", "walls", "zones", "points")
WALL_SHAPES = {"line": ("points",), "pillar": ("cx", "cy", "r"), "rect": ("x", "y", "w", "h")}
ZONE_SHAPES = {"rect": ("x", "y", "w", "h"), "circle": ("cx", "cy", "r"), "polygon": ("points",)}


def check_schema(venue):
    errs = []
    for k in REQUIRED_TOP:
        if k not in venue:
            errs.append(f"missing top-level key {k!r}")
    if errs:
        return errs   # no point going deeper without the basics

    for w in venue.get("walls", []):
        shape = w.get("shape", "line")
        if shape not in WALL_SHAPES:
            errs.append(f"wall {w.get('id','?')}: unknown shape {shape!r}")
            continue
        for f in WALL_SHAPES[shape]:
            if f not in w:
                errs.append(f"wall {w.get('id','?')} (shape={shape}): missing {f!r}")
        if "id" not in w:
            errs.append("a wall is missing 'id'")

    for z in venue.get("zones", []):
        shape = z.get("shape", "rect")
        if shape not in ZONE_SHAPES:
            errs.append(f"zone {z.get('id','?')}: unknown shape {shape!r}")
            continue
        for f in ZONE_SHAPES[shape]:
            if f not in z:
                errs.append(f"zone {z.get('id','?')} (shape={shape}): missing {f!r}")
        if "id" not in z:
            errs.append("a zone is missing 'id'")
        if z.get("type") not in (None, "stage", "bar", "seating", "restroom", "merch",
                                  "coat-check", "restricted", "custom"):
            pass   # spec says unrecognized types are fine (treated as custom)

    for p in venue.get("points", []):
        for f in ("id", "type", "x", "y"):
            if f not in p:
                errs.append(f"point {p.get('id','?')}: missing {f!r}")
        if p.get("type") not in ("entrance", "exit", "emergency-exit", "info", "security", "custom"):
            errs.append(f"point {p.get('id','?')}: unusual type {p.get('type')!r} (not a hard error)")

    exits = [p for p in venue.get("points", []) if p.get("type") in ("exit", "emergency-exit")]
    pop = [z for z in venue.get("zones", []) if (z.get("capacity") or 0) > 0]
    if not exits:
        errs.append("no exit/emergency-exit point -- evacuation scenario will be a no-op")
    if not pop:
        errs.append("no zone with capacity > 0 -- nobody to simulate")
    return errs


def check_pipeline(venue, label, verbose=True):
    """The real test: does arena/sim actually run on this venue?"""
    problems = []

    try:
        spec = arena.build_spec(venue)
    except Exception as exc:
        return [f"arena.build_spec crashed: {type(exc).__name__}: {exc}"]
    if verbose:
        print(f"    parameter vector: {spec.dim} dims across {len(spec.entries)} movable elements")
    if spec.dim == 0:
        problems.append("zero movable elements -- nothing for the optimizer to search over")

    try:
        u0 = arena.default_u(venue, spec)
        movable = arena.unpack(u0, venue, spec)
    except Exception as exc:
        return problems + [f"pack/unpack crashed: {type(exc).__name__}: {exc}"]

    # containment: every decoded element must stay inside the fixed shell
    bx0, by0, bx1, by1 = spec.bounds
    for eid, geo in movable.items():
        gx0, gy0, gx1, gy1 = arena._shape_bbox(geo)
        if gx0 < bx0 - 1e-6 or gy0 < by0 - 1e-6 or gx1 > bx1 + 1e-6 or gy1 > by1 + 1e-6:
            problems.append(f"{eid}: decoded outside the building shell "
                            f"({gx0:.2f},{gy0:.2f})-({gx1:.2f},{gy1:.2f}) vs bounds {spec.bounds}")

    # round-trip: default_u should reproduce the drawn layout
    worst = 0.0
    for e in spec.entries:
        a = arena._shape_bbox(movable[e["id"]])
        b = arena._shape_bbox(e["geo0"])
        worst = max(worst, max(abs(x - y) for x, y in zip(a, b)))
    if worst > 0.5:
        problems.append(f"default_u round-trip off by {worst:.2f}m (expected ~0, some slack for line walls)")

    try:
        vg = sim.Venue(venue, movable, spec.room)
    except Exception as exc:
        return problems + [f"sim.Venue crashed: {type(exc).__name__}: {exc}"]
    if verbose:
        print(f"    grid {vg.walkable.shape}, walkable area {vg.area:.0f} m^2, "
              f"{len(vg.exits)} exit(s), {len(vg.entrances)} entrance(s), "
              f"{len(vg.attractors)} attractor(s)")
    if vg.walkable.sum() == 0:
        return problems + ["zero walkable cells -- venue is entirely obstacles"]
    if not vg.exits:
        problems.append("no exits after rasterization -- evacuation is meaningless here")

    for scenario in ("evacuation", "circulation", "headliner"):
        try:
            r = sim.run(vg, scenario, horizon=90.0)   # short horizon: this is a smoke test
        except Exception as exc:
            problems.append(f"sim.run({scenario}) crashed: {type(exc).__name__}: {exc}")
            continue
        clip_frac = r["n_clipped"] / max(r["n_in"], 1e-9)
        if verbose:
            print(f"    {scenario:12s} n_in {r['n_in']:7.1f}  ledger_err {r['ledger_error']:9.2e}"
                  f"  clipped {clip_frac:6.2%}  disconnected {r['disconnected']}")
        if abs(r["ledger_error"]) > 1e-3 * max(r["n_in"], 1.0):
            problems.append(f"{scenario}: ledger error {r['ledger_error']:.3e} (4.7 should be ~0)")
        if clip_frac > 0.05:
            problems.append(f"{scenario}: {clip_frac:.1%} of the crowd was clipped (design doc bar is 1%)")
        if r["disconnected"] and r["n_in"] > 0:
            problems.append(f"{scenario}: some populated area cannot reach any target -- check exit placement")
        if np.isnan(r["peak_rho"]).any():
            problems.append(f"{scenario}: NaN in the density map")

    return problems


def validate(path, verbose=True):
    venue = arena.load(path)
    print(f"\n=== {path} ===")
    schema_errs = check_schema(venue)
    for e in schema_errs:
        print(f"  [schema] {e}")
    if any("missing top-level" in e for e in schema_errs):
        return False

    pipe_errs = check_pipeline(venue, path, verbose=verbose)
    for e in pipe_errs:
        print(f"  [pipeline] {e}")

    ok = not schema_errs and not pipe_errs
    print(f"  {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", help="venue JSON file(s) or globs")
    ap.add_argument("-q", "--quiet", action="store_true")
    args = ap.parse_args()

    files = []
    for p in args.paths:
        files.extend(sorted(glob.glob(p)) or [p])

    results = {f: validate(f, verbose=not args.quiet) for f in files}
    print(f"\n{'='*60}\n{sum(results.values())}/{len(results)} venues pass\n{'='*60}")
    for f, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {f}")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
