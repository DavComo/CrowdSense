"""
run_pipeline.py -- the whole ML loop, start to finish, on a real venue file.

    1. generate training data by calling the REAL simulator many times
       (sim.py: Hughes continuum, Weidmann speed law, eikonal routing)
    2. train the surrogate to imitate its cost
    3. optimise THROUGH the frozen surrogate  <-- this is "the ML"
    4. RE-SIMULATE every candidate on the full scenario suite before showing
       anything. Surrogate numbers are never the answer; sim numbers are
       (design doc D4).

The cost being minimized is Hackathon.docx's excess-magnitude density penalty
(softplus form), averaged over the scenario suite -- normal circulation, an
evacuation, a headliner surge, and incidents at arbitrary points on the floor.
"""

import os
import time
import numpy as np
from multiprocessing import Pool

import arena
from surrogate import Surrogate, gradient_search

_HERE = os.path.dirname(os.path.abspath(__file__))
_CANDIDATES = [
    os.path.join(_HERE, "..", "examples", "sample-venue.json"),
    os.path.join(_HERE, "sample-venue.json"),
]
VENUE_PATH = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[-1])

N_TRAIN = int(os.environ.get("CROWDSENSE_N", 420))
N_TEST = max(int(N_TRAIN * 0.15), 30)
N_WORKERS = int(os.environ.get("CROWDSENSE_WORKERS", max(os.cpu_count() - 2, 1)))

# ---- worker: each process rebuilds the venue once, then just scores ----
_W = {}

def _init_worker(path):
    _W["venue"] = arena.load(path)
    _W["spec"] = arena.build_spec(_W["venue"])
    _W["train_suite"] = arena.training_suite(_W["venue"], _W["spec"])
    _W["full_suite"] = arena.default_suite(_W["venue"], _W["spec"])

def _score_train(u):
    return arena.objective(_W["venue"], u, _W["spec"], suite=_W["train_suite"])

def _score_full(u):
    """Full suite, and the per-scenario breakdown for reporting."""
    results = arena.simulate(_W["venue"], u, _W["spec"], suite=_W["full_suite"])
    total = sum(r["weight"] * r["terms"]["cost"] for r in results)
    total /= max(sum(r["weight"] for r in results), 1e-9)
    slim = [{"label": r["label"], "weight": r["weight"], **r["terms"],
             "n_in": r["n_in"], "n_out": r["n_out"], "n_clipped": r["n_clipped"],
             "ledger_error": r["ledger_error"]} for r in results]
    return total, slim


def main():
    venue = arena.load(VENUE_PATH)
    spec = arena.build_spec(venue)
    DIM = spec.dim
    print(f"loaded venue: {VENUE_PATH}")
    print(f"movable elements: {len(spec.entries)}  ->  {DIM}-dim parameter vector")
    for e in spec.entries:
        print(f"    {e['kind']:5s} {e['id']:16s} {e['geo0']['shape']:8s}"
              f" {'extendable' if e['extendable'] else 'fixed size'}  ({e['n']} params)")

    rng = np.random.default_rng(0)
    u0 = arena.default_u(venue, spec)

    # ---- 1. data generation, on the real simulator ----
    print(f"\ngenerating training data from the simulator "
          f"({N_TRAIN + N_TEST} runs on {N_WORKERS} workers) ...")
    X = np.vstack([u0[None, :], rng.uniform(0, 1, size=(N_TRAIN - 1, DIM))])
    X_test = rng.uniform(0, 1, size=(N_TEST, DIM))
    t0 = time.time()
    with Pool(N_WORKERS, initializer=_init_worker, initargs=(VENUE_PATH,)) as pool:
        y = np.array(pool.map(_score_train, list(X), chunksize=2))
        y_test = np.array(pool.map(_score_train, list(X_test), chunksize=2))
    print(f"  {N_TRAIN} samples in {time.time()-t0:.0f}s, cost range [{y.min():.3f}, {y.max():.3f}]")

    # ---- 2. train ----
    print("\ntraining surrogate ...")
    net = Surrogate(n_in=DIM, seed=1)
    net.fit(X, y, epochs=3000, lr=0.05)
    pred = net.predict(X_test)
    mae = float(np.mean(np.abs(pred - y_test)))
    ss_res = float(np.sum((pred - y_test) ** 2))
    ss_tot = float(np.sum((y_test - y_test.mean()) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    rank = np.corrcoef(np.argsort(np.argsort(pred)), np.argsort(np.argsort(y_test)))[0, 1]
    print(f"\n  held-out MAE        : {mae:.4f}   (cost sd {y_test.std():.4f})")
    print(f"  held-out R^2        : {r2:.3f}   <- design doc 6.4 wants > 0.7 before trusting it")
    print(f"  held-out rank corr. : {rank:.3f}   <- does it RANK layouts like the simulator")
    trust = r2 > 0.7

    # ---- 3. optimise through the frozen surrogate ----
    print("\nsearching for a better layout (gradient descent on the surrogate) ...")
    starts = [u0] + [rng.uniform(0, 1, DIM) for _ in range(48)]
    cands = []
    for s in starts:
        c = gradient_search(net, s, steps=250, lr=0.03)
        cands.append((float(net.predict(c)[0]), c))
    cands.sort(key=lambda t: t[0])
    # de-duplicate: gradient descent from different starts often lands together
    picks = []
    for pred_cost, c in cands:
        if all(np.linalg.norm(c - p) > 0.05 for _, p in picks):
            picks.append((pred_cost, c))
        if len(picks) >= 3:
            break
    best_random = X[int(np.argmin(y))]
    print(f"  surrogate's top {len(picks)} candidates predicted at "
          f"{', '.join(f'{p:.3f}' for p, _ in picks)}")

    # ---- 4. re-simulate everything on the FULL suite before believing it ----
    print(f"\nre-simulating {len(picks)+2} candidates on the full scenario suite "
          f"(incl. incidents) ...")
    to_verify = [u0] + [c for _, c in picks] + [best_random]
    labels = ["original"] + [f"surrogate #{i+1}" for i in range(len(picks))] + ["best sampled"]
    t0 = time.time()
    with Pool(min(N_WORKERS, len(to_verify)), initializer=_init_worker,
              initargs=(VENUE_PATH,)) as pool:
        verified = pool.map(_score_full, to_verify)
    print(f"  done in {time.time()-t0:.0f}s")

    print(f"\n{'candidate':16s} {'real cost':>10s}   verdict")
    base_cost = verified[0][0]
    for lab, (cost, _) in zip(labels, verified):
        delta = 100 * (base_cost - cost) / base_cost if base_cost else 0.0
        note = "baseline" if lab == "original" else (f"{delta:+.1f}% vs original")
        print(f"{lab:16s} {cost:10.4f}   {note}")

    # SAFETY NET: pick the best VERIFIED candidate, never the surrogate's word.
    order = sorted(range(len(verified)), key=lambda i: verified[i][0])
    win = order[0]
    best_u, (best_cost, best_break) = to_verify[win], verified[win]
    if win == 0:
        print("\n  nothing beat the original layout on the real simulator. Shipping the original.")
    elif labels[win] == "best sampled":
        print("\n  the surrogate's picks did NOT beat plain random sampling; "
              "falling back to the best sampled layout (D4 safety net).")
    else:
        print(f"\n  winner: {labels[win]}, verified on the simulator.")
    if not trust:
        print("  NOTE: held-out R^2 below the 0.7 guardrail -- the surrogate is "
              "in progress; the result above is still simulator-verified.")

    # ---- report: every scenario, before and after ----
    _, base_break = verified[0]
    print(f"\n{'scenario':26s} {'cost before':>11s} {'cost after':>11s} "
          f"{'peak rho':>9s} {'T95':>9s} {'danger':>8s}")
    for b, a in zip(base_break, best_break):
        t95 = f"{a['T95']:.0f}s" + ("" if a["T95_reached"] else "*")
        print(f"{b['label']:26s} {b['cost']:11.4f} {a['cost']:11.4f} "
              f"{a['peak_rho']:9.2f} {t95:>9s} {a['danger_frac']:8.3f}")
    print("  * T95 not reached inside the horizon")

    worst = max(abs(s["ledger_error"]) for s in best_break)
    clipped = max(s["n_clipped"] / max(s["n_in"], 1) for s in best_break)
    print(f"\nledger check (4.7): worst error {worst:.2e}   worst clipped fraction {clipped:.2%}"
          f"   {'OK' if clipped < 0.01 else 'INVALID -- over the 1% bar'}")

    np.savez(os.path.join(_HERE, "pipeline_result.npz"), u0=u0, u1=best_u)
    out_path = os.path.join(_HERE, "optimized-venue.json")
    arena.write_sim_result(venue, u0, best_u, base_break, best_break, spec, out_path)
    print(f"\nwrote {out_path}")
    print("(a full venue file -- open it in the CrowdSense editor to see the optimized layout;")
    print(" results also live under its top-level \"simulation\" key)")


if __name__ == "__main__":
    main()
