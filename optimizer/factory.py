"""
factory.py -- the data factory (design doc S5) for the U-Net surrogate.

Samples layouts, runs the REAL simulator on each under every scenario, and
stores what 6.2 trains on:

    x       [N_IN, H, W]  input channels (unet.Raster, sharp temperature)
    y_map   [2, H, W]     peak density / RHO_MAX, and sustained-danger mask
    y_scal  [len(SCALARS)] sim.SCALARS = (cost, severity, danger_frac, max_P) --
             `cost` is the ONLY one the optimizer trains against; the rest
             ride along as diagnostics (see sim.appraise()'s docstring)

Workers return only numpy maps and scalars -- channels are rasterized in the
parent, so no worker has to import torch. A worker exception logs the seed
and continues; one bad layout must not kill the run (S5).

    python3 factory.py --n 600 --out data/
"""

import argparse
import os
import time
import numpy as np
from multiprocessing import Pool

import arena
import sim

SCENARIOS = ("circulation", "evacuation", "headliner")
HORIZONS = arena.SCENARIO_HORIZONS   # single source of truth -- see its comment in arena.py
WEIGHTS = {"circulation": 0.8, "evacuation": 1.0, "headliner": 1.0}

_W = {}


def _init(path):
    _W["venue"] = arena.load(path)
    _W["spec"] = arena.build_spec(_W["venue"])


def _one(args):
    """Run every scenario for one layout. Returns (u, {scenario: (maps, scalars)})."""
    i, u = args
    try:
        venue, spec = _W["venue"], _W["spec"]
        movable = arena.unpack(u, venue, spec)
        vg = sim.Venue(venue, movable, spec.room)
        H, W = vg.walkable.shape
        out = {}
        for s in SCENARIOS:
            r = sim.run(vg, s, horizon=HORIZONS[s])
            t = sim.appraise(r)
            peak = np.clip(r["peak_rho"] / sim.RHO_MAX, 0.0, 1.0).astype(np.float32)
            danger = (r["peak_rho"] > sim.RHO_D).astype(np.float32)
            scal = np.array([t[name] for name in sim.SCALARS], dtype=np.float32)
            out[s] = (np.stack([peak, danger]), scal,
                      float(r["n_clipped"] / max(r["n_in"], 1e-9)))
        return i, u, out, None
    except Exception as exc:                      # S5: log the seed, keep going
        return i, u, None, f"{type(exc).__name__}: {exc}"


VALID_CLIP_FRACTION = 0.01   # design doc 4.4/5: over this, the run is invalid


def _drop_invalid(rows, log=print):
    """Design doc: 'if the clipped total exceeds 1% of N_in the run is
    flagged invalid in the dataset.' Enforced per-scenario -- a bad scenario
    on an otherwise fine layout still poisons the density-map target for
    that scenario if it isn't dropped before it reaches the U-Net."""
    kept, dropped = [], 0
    for u, out in rows:
        good = {s: v for s, v in out.items() if v[2] <= VALID_CLIP_FRACTION}
        dropped += len(out) - len(good)
        if good:
            kept.append((u, good))
    if dropped:
        log(f"    dropped {dropped} scenario-runs over the {VALID_CLIP_FRACTION:.0%} "
            f"clipped-mass bar (design doc 4.4/5 validity rule)")
    return kept


def generate(venue_path, n, workers, seed=0, log=print):
    venue = arena.load(venue_path)
    spec = arena.build_spec(venue)
    rng = np.random.default_rng(seed)

    # the drawn layout, plus random ones. S5's "variation guard" in spirit:
    # jitter around the original as well as uniform draws, so the net sees
    # both plausible layouts and the wild ones the search may wander into.
    u0 = arena.default_u(venue, spec)
    n_jit = n // 4
    jitter = np.clip(u0[None, :] + rng.normal(0, 0.15, size=(n_jit, spec.dim)), 0, 1)
    U = np.vstack([u0[None, :], jitter, rng.uniform(0, 1, size=(n - n_jit - 1, spec.dim))])

    t0 = time.time()
    rows, bad = [], 0
    with Pool(workers, initializer=_init, initargs=(venue_path,)) as pool:
        for k, (i, u, out, err) in enumerate(pool.imap_unordered(_one, list(enumerate(U)), chunksize=2)):
            if err:
                bad += 1
                log(f"    sample {i} failed ({err}) -- skipped")
                continue
            rows.append((u, out))
            if (k + 1) % 50 == 0:
                el = time.time() - t0
                log(f"    {k+1}/{len(U)} layouts   {el:.0f}s elapsed, "
                    f"~{el/(k+1)*(len(U)-k-1):.0f}s left")
    log(f"  {len(rows)} layouts x {len(SCENARIOS)} scenarios in {time.time()-t0:.0f}s"
        f"{f' ({bad} failed)' if bad else ''}")
    rows = _drop_invalid(rows, log=log)
    n_scenarios = sum(len(out) for _, out in rows)
    log(f"  {n_scenarios} valid (layout, scenario) pairs after the validity filter")
    return venue, spec, rows


def to_tensors(venue, spec, rows, log=print):
    """Rasterize inputs and stack everything the U-Net trains on."""
    import torch
    import unet
    raster = unet.Raster(venue, spec)
    H0, W0 = raster.H0, raster.W0
    Hp, Wp = raster.H, raster.W

    X, Ym, Ys, meta = [], [], [], []
    worst_clip = 0.0
    for u, out in rows:
        u_t = torch.tensor(u, dtype=torch.float32)
        for s in SCENARIOS:
            if s not in out:          # dropped by _drop_invalid
                continue
            maps, scal, clip = out[s]
            worst_clip = max(worst_clip, clip)
            with torch.no_grad():
                ch = raster.channels(u_t, s).numpy().astype(np.float32)
            padded = np.zeros((2, Hp, Wp), dtype=np.float32)
            padded[:, :H0, :W0] = maps
            X.append(ch); Ym.append(padded); Ys.append(scal)
            meta.append((u, s))
    log(f"  tensors: X {len(X)}x{X[0].shape}  worst clipped fraction {worst_clip:.2%}"
        f"  {'OK' if worst_clip < 0.01 else 'SOME RUNS OVER THE 1% BAR'}")
    return raster, np.stack(X), np.stack(Ym), np.stack(Ys), meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=600)
    ap.add_argument("--workers", type=int, default=max(os.cpu_count() - 2, 1))
    ap.add_argument("--out", default="data")
    ap.add_argument("--venue", default=None)
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    venue_path = args.venue or next(
        p for p in [os.path.join(here, "..", "examples", "sample-venue.json"),
                    os.path.join(here, "sample-venue.json")] if os.path.exists(p))
    os.makedirs(os.path.join(here, args.out), exist_ok=True)

    print(f"venue: {venue_path}")
    print(f"generating {args.n} layouts x {len(SCENARIOS)} scenarios on {args.workers} workers ...")
    venue, spec, rows = generate(venue_path, args.n, args.workers)
    raster, X, Ym, Ys, meta = to_tensors(venue, spec, rows)
    path = os.path.join(here, args.out, "shard_000.npz")
    np.savez_compressed(path, X=X, Y_maps=Ym, Y_scal=Ys,
                        U=np.stack([m[0] for m in meta]),
                        S=np.array([m[1] for m in meta]))
    print(f"wrote {path}  ({os.path.getsize(path)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
