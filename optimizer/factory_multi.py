"""factory_multi.py -- data generation across MANY DIFFERENT VENUES, not many
arrangements of one venue. This is what design doc 6.2's fixed x[4,64,64]
input is actually for: one U-Net trained across a whole distribution of room
shapes, so it can predict a density map for a venue it has never seen, not
just search over furniture positions within one fixed shell.

`factory.py` (many layouts, one venue) and this file (many venues, a couple
of layouts each) produce the SAME tensor format -- N_IN channels, a 2-channel
map target, a len(SCALARS) scalar target -- on the SAME fixed 64x64 canonical
grid (unet.Raster(..., canon_hw=CANON)), so `run_multi_venue_pipeline.py`
trains on either, or both concatenated, with no special-casing.

    python3 factory_multi.py --n 700 --layouts-per-venue 2
"""
import argparse
import os
import time
import numpy as np
from multiprocessing import Pool

import arena
import sim
import sample_venue

SCENARIOS = ("circulation", "evacuation", "headliner")
HORIZONS = arena.SCENARIO_HORIZONS
CANON = (64, 64)   # design doc 6.2/D6: fixed grid every venue is rasterized onto

_W = {}


def _one(args):
    """One (venue, layout) pair, all 3 scenarios, on the canonical grid.
    Rasterization happens here too (not just simulation) so a worker never
    needs to import torch -- unet.Raster's *hard* (non-differentiable) path
    reuses arena's own rasterizer, which is torch-free."""
    idx, venue, u = args
    try:
        spec = arena.build_spec(venue)
        movable = arena.unpack(u, venue, spec)
        room = spec.room
        geo = arena._effective_geo(venue, movable)
        obstacle = arena._build_obstacle(venue, geo, room, cell=sim.DX)
        H0, W0 = obstacle.shape
        Hc, Wc = min(H0, CANON[0]), min(W0, CANON[1])
        if Hc < 4 or Wc < 4:
            return idx, None, "venue too large for the canonical window (heavily cropped)"

        vg = sim.Venue(venue, movable, room)
        out = {}
        for s in SCENARIOS:
            r = sim.run(vg, s, horizon=HORIZONS[s])
            if r.get("rejected"):
                continue
            t = sim.appraise(r)
            peak_c = np.zeros(CANON, dtype=np.float32)
            danger_c = np.zeros(CANON, dtype=np.float32)
            peak_c[:Hc, :Wc] = np.clip(r["peak_rho"][:Hc, :Wc] / sim.RHO_MAX, 0.0, 1.0)
            danger_c[:Hc, :Wc] = (r["peak_rho"][:Hc, :Wc] > sim.RHO_D).astype(np.float32)
            scal = np.array([t[name] for name in sim.SCALARS], dtype=np.float32)
            clip = r["n_clipped"] / max(r["n_in"], 1e-9)
            out[s] = (np.stack([peak_c, danger_c]), scal, clip, (H0, W0))
        return idx, out, None
    except Exception as exc:
        return idx, None, f"{type(exc).__name__}: {exc}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=700, help="number of DIFFERENT venues")
    ap.add_argument("--layouts-per-venue", type=int, default=2)
    ap.add_argument("--workers", type=int, default=max(os.cpu_count() - 2, 1))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="data")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, args.out), exist_ok=True)

    print(f"generating {args.n} venues x {args.layouts_per_venue} layouts x {len(SCENARIOS)} "
          f"scenarios on {args.workers} workers ...")
    jobs, meta = [], []
    idx = 0
    venues_by_idx = {}
    for kind, venue in sample_venue.generate(args.n, seed=args.seed):
        spec = arena.build_spec(venue)
        rng = np.random.default_rng(args.seed * 100003 + idx)
        u0 = arena.default_u(venue, spec)
        layouts = [u0] + [rng.uniform(0, 1, spec.dim) for _ in range(args.layouts_per_venue - 1)]
        for u in layouts:
            jobs.append((idx, venue, u)); meta.append(kind)
            venues_by_idx[idx] = venue
            idx += 1

    t0 = time.time()
    results = [None] * len(jobs)
    bad = 0
    with Pool(args.workers) as pool:
        for k, (i, out, err) in enumerate(pool.imap_unordered(_one, jobs, chunksize=2)):
            if err:
                bad += 1
                if bad <= 10:
                    print(f"    pair {i} ({meta[i]}) failed/skipped: {err}")
                continue
            results[i] = out
            if (k + 1) % 200 == 0:
                el = time.time() - t0
                print(f"    {k+1}/{len(jobs)}   {el:.0f}s elapsed, ~{el/(k+1)*(len(jobs)-k-1):.0f}s left")
    print(f"  {len(jobs)} pairs simulated in {time.time()-t0:.0f}s ({bad} failed/skipped)")

    # rasterize on the canonical grid -- this needs torch (unet.Raster), done
    # here in the parent process after simulation, not in workers, so workers
    # stay torch-free (factory.py's own convention).
    import unet
    print("rasterizing onto the canonical 64x64 grid ...")
    X, Ym, Ys, V = [], [], [], []
    worst_clip = 0.0
    t0 = time.time()
    raster_cache = {}
    for i, out in enumerate(results):
        if not out:
            continue
        venue = venues_by_idx[i]
        spec = arena.build_spec(venue)
        u = jobs[i][2]
        # one Raster per DISTINCT venue (fixed structure is baked at build
        # time), reused across that venue's layouts/scenarios
        key = id(venue)
        if key not in raster_cache:
            raster_cache[key] = unet.Raster(venue, spec, canon_hw=CANON)
        raster = raster_cache[key]
        import torch
        u_t = torch.tensor(u, dtype=torch.float32)
        for s in SCENARIOS:
            if s not in out:
                continue
            maps, scal, clip, _ = out[s]
            if clip > 0.01:
                continue
            worst_clip = max(worst_clip, clip)
            with torch.no_grad():
                ch = raster.channels(u_t, s).numpy().astype(np.float32)
            X.append(ch); Ym.append(maps); Ys.append(scal); V.append(meta[i])
    print(f"  rasterized {len(X)} samples in {time.time()-t0:.0f}s "
          f"(worst clipped fraction {worst_clip:.2%})")

    path = os.path.join(here, args.out, "shard_multi_venue.npz")
    np.savez_compressed(path, X=np.stack(X), Y_maps=np.stack(Ym), Y_scal=np.stack(Ys),
                        venue_kind=np.array(V))
    print(f"wrote {path}  ({os.path.getsize(path)/1e6:.1f} MB, {len(X)} samples "
          f"across {len(raster_cache)} distinct venues)")


if __name__ == "__main__":
    main()
