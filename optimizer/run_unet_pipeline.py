"""
run_unet_pipeline.py -- the U-Net version of the loop (design doc 6.2-6.4).

    1. load the data factory's shards (or generate them)
    2. train the U-Net: density-map head + cost head
    3. 6.3 -- freeze it, run projected gradient descent on the LAYOUT VECTOR
       through the frozen net (the gradient lands on ~15 numbers, never on
       pixels, so there is no way to produce non-physical wall soup)
    4. take the top candidates, RE-SIMULATE each one, and report only the
       simulator's numbers. 6.4: if hold-out R^2 on the cost is below 0.7,
       say so and lean on the verified result rather than the surrogate.

    python3 factory.py --n 700          # once, ~8 min
    python3 run_unet_pipeline.py
"""

import os
import time
import numpy as np
import torch

import arena
import sim
import unet
import factory

_HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(_HERE, "data", "shard_000.npz")
SCEN = unet.SCENARIOS
WEIGHTS = [factory.WEIGHTS[s] for s in SCEN]
EPOCHS = int(os.environ.get("CROWDSENSE_EPOCHS", 40))

_W = {}


def _init(path):
    _W["venue"] = arena.load(path)
    _W["spec"] = arena.build_spec(_W["venue"])
    _W["suite"] = arena.default_suite(_W["venue"], _W["spec"])


def _quick_feasible(venue, u, spec, suite):
    """Cheap pre-filter before the expensive full-suite re-simulation: does
    this candidate even pass sim.check_feasible() on every scenario? A pure
    density cost has a known blind spot (see sim.appraise()'s docstring) --
    a disconnected pocket that never gets dense enough to cross rho_safe
    scores as cheap, so the search occasionally wanders there. Catching that
    with one eikonal solve per scenario (milliseconds) instead of a full
    3000-step re-simulation (seconds) means more of the expensive budget
    goes to candidates that actually have a chance of shipping."""
    movable = arena.unpack(u, venue, spec)
    vg = sim.Venue(venue, movable, spec.room)
    for item in suite:
        cfg = sim.make_scenario(vg, item["scenario"], incident=item.get("incident"))
        ok, _ = sim.check_feasible(vg, cfg)
        if not ok:
            return False
    return True


def _verify(u):
    """Full suite on the real simulator -- incidents included."""
    results = arena.simulate(_W["venue"], u, _W["spec"], suite=_W["suite"])
    total = sum(r["weight"] * r["terms"]["cost"] for r in results)
    total /= max(sum(r["weight"] for r in results), 1e-9)
    slim = [{"label": r["label"], **{k: v for k, v in r["terms"].items()},
             "n_in": r["n_in"], "n_out": r["n_out"], "n_clipped": r["n_clipped"],
             "ledger_error": r["ledger_error"]} for r in results]
    # design doc 4.4/5's own validity bar, applied to the number we're about
    # to show someone -- not just to factory training data. A candidate that
    # fails it is never the answer, no matter how good its cost looks.
    valid = all(s["n_clipped"] / max(s["n_in"], 1e-9) <= 0.01 and not s["disconnected"] for s in slim)
    return total, slim, valid


def main():
    from multiprocessing import Pool

    venue_path = next(p for p in [os.path.join(_HERE, "..", "examples", "sample-venue.json"),
                                   os.path.join(_HERE, "sample-venue.json")] if os.path.exists(p))
    venue = arena.load(venue_path)
    spec = arena.build_spec(venue)
    print(f"loaded venue: {venue_path}")
    print(f"movable elements: {len(spec.entries)}  ->  {spec.dim}-dim layout vector")

    if not os.path.exists(DATA):
        raise SystemExit(f"no training data at {DATA}\nrun:  python3 factory.py --n 700")
    d = np.load(DATA, allow_pickle=True)
    X, Ym, Ys = d["X"], d["Y_maps"], d["Y_scal"]
    print(f"\ndataset: {len(X)} samples ({len(X)//len(SCEN)} layouts x {len(SCEN)} scenarios)"
          f"  channels {X.shape[1]}  grid {X.shape[2]}x{X.shape[3]}")
    print(f"  cost range [{Ys[:,0].min():.3f}, {Ys[:,0].max():.3f}]  mean {Ys[:,0].mean():.3f}")

    # ---- 2. train ----
    print(f"\ntraining U-Net ({EPOCHS} epochs) ...")
    raster = unet.Raster(venue, spec)
    t0 = time.time()
    surr, r2, rank = unet.train(raster, X, Ym, Ys, epochs=EPOCHS)
    print(f"  trained in {time.time()-t0:.0f}s")
    print(f"\n  held-out R^2   cost {r2['cost']:.3f}   severity {r2['severity']:.3f}"
          f"   danger_frac {r2['danger_frac']:.3f}   max_P {r2['max_P']:.3f}")
    print(f"  held-out R^2 on the PEAK DENSITY MAP : {r2['peak_map']:.3f}")
    print(f"  held-out rank corr. on cost          : {rank:.3f}")
    trust = r2["cost"] > 0.7
    print(f"  6.4 guardrail (R^2 > 0.7 on cost): {'PASS' if trust else 'FAIL -- surrogate is in progress'}")

    # ---- 3. gradient through the frozen surrogate (6.3) ----
    print("\nprojected gradient descent on the layout vector through the frozen net ...")
    rng = np.random.default_rng(0)
    u0 = arena.default_u(venue, spec)
    full_suite = arena.default_suite(venue, spec)
    n_starts = 60
    starts = [u0] + [rng.uniform(0, 1, spec.dim) for _ in range(n_starts - 1)]
    cands = []
    t0 = time.time()
    n_infeasible = 0
    for s in starts:
        u_opt, j = unet.gradient_search(surr, s, SCEN, WEIGHTS, steps=200, lr=0.02)
        if not _quick_feasible(venue, u_opt, spec, full_suite):
            n_infeasible += 1   # disconnects something -- the density cost
            continue            # can't see this (appraise()'s own caveat);
        cands.append((j, u_opt))   # don't waste a full-suite re-sim on it
    cands.sort(key=lambda t: t[0])
    picks = []
    for j, c in cands:
        if all(np.linalg.norm(c - p) > 0.05 for _, p in picks):
            picks.append((j, c))
        if len(picks) >= 4:
            break
    print(f"  {n_starts} starts in {time.time()-t0:.0f}s ({n_infeasible} pre-filtered as "
          f"infeasible before wasting a full re-simulation on them)")
    print(f"  top {len(picks)} predicted at {', '.join(f'{j:.3f}' for j, _ in picks) or '(none survived)'}")
    print(f"  (surrogate numbers -- not shown to anyone as a result, per D4)")

    # ---- 4. re-simulate everything ----
    to_verify = [u0] + [c for _, c in picks]
    labels = ["original"] + [f"U-Net #{i+1}" for i in range(len(picks))]
    print(f"\nre-simulating {len(to_verify)} candidates on the full scenario suite ...")
    t0 = time.time()
    with Pool(min(len(to_verify), max(os.cpu_count() - 2, 1)),
              initializer=_init, initargs=(venue_path,)) as pool:
        verified = pool.map(_verify, to_verify)
    print(f"  done in {time.time()-t0:.0f}s")

    base_cost = verified[0][0]
    print(f"\n{'candidate':14s} {'surrogate':>10s} {'REAL cost':>10s}   verdict")
    for i, (lab, (cost, _, valid)) in enumerate(zip(labels, verified)):
        pred = f"{picks[i-1][0]:10.3f}" if i > 0 else f"{'-':>10s}"
        tag = "" if valid else "  [INVALID: >1% clipped or disconnected somewhere -- see 4.4/5]"
        note = "baseline" if i == 0 else f"{100*(base_cost-cost)/base_cost:+.1f}% vs original"
        print(f"{lab:14s} {pred} {cost:10.4f}   {note}{tag}")

    # rank valid candidates first -- a cheaper-looking number that fails the
    # design doc's own clipped-mass bar is not actually a better layout,
    # it's a simulation that quietly lost some of its crowd.
    order = sorted(range(len(verified)), key=lambda i: (not verified[i][2], verified[i][0]))
    win = order[0]
    best_u, (best_cost, best_break, best_valid) = to_verify[win], verified[win]
    _, base_break, _ = verified[0]
    if win == 0:
        print("\n  nothing beat the original on the real simulator. Shipping the original.")
    elif not best_valid:
        print(f"\n  every improved candidate failed the validity bar -- falling back to the "
              f"original rather than ship an invalid result.")
        win, best_u, (best_cost, best_break, best_valid) = 0, u0, verified[0]
    else:
        print(f"\n  winner: {labels[win]} -- {100*(base_cost-best_cost)/base_cost:+.1f}% "
              f"on the simulator, not on the surrogate's say-so. (validity check: PASS)")
    if not trust:
        print("  NOTE: R^2 below the 6.4 bar, so the search is exploratory; the number"
              "\n  above is still a real simulator result for a real layout.")

    print(f"\n{'scenario':26s} {'before':>9s} {'after':>9s} {'peak ρ':>8s} {'max dens':>9s} "
          f"{'T95':>8s} {'danger':>7s}")
    for b, a in zip(base_break, best_break):
        t95 = f"{a['T95']:.0f}s" + ("" if a["T95_reached"] else "+")
        print(f"{b['label']:26s} {b['cost']:9.4f} {a['cost']:9.4f} {a['peak_rho']:8.2f} "
              f"{a['max_density']:9.2f} {t95:>8s} {a['danger_frac']:7.3f}")
    worst = max(abs(s["ledger_error"]) for s in best_break)
    clip = max(s["n_clipped"] / max(s["n_in"], 1) for s in best_break)
    print(f"\nledger (4.7): worst error {worst:.2e}   worst clipped {clip:.2%}"
          f"   {'OK' if clip < 0.01 else 'INVALID'}")

    np.savez(os.path.join(_HERE, "pipeline_result.npz"), u0=u0, u1=best_u)
    torch.save(surr.net.state_dict(), os.path.join(_HERE, "unet_surrogate.pt"))
    arena.write_sim_result(venue, u0, best_u, base_break, best_break, spec,
                           os.path.join(_HERE, "optimized-venue.json"))
    print(f"\nwrote optimized-venue.json, unet_surrogate.pt, pipeline_result.npz")
    print("run  python3 show_pipeline.py  for the before/after figure, or")
    print("     python3 show_unet.py      to see what the U-Net predicts vs the simulator")


if __name__ == "__main__":
    main()
