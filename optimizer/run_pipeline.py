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

import argparse
import json
import os
import time
import numpy as np
from multiprocessing import Pool

import arena
import sim
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
    """Full suite, the per-scenario breakdown for reporting, and whether
    ANYTHING in this candidate overlaps anything else (arena.layout_overlaps
    -- no two zones, no two pieces of furniture, and no furniture inside a
    zone either, movable or fixed, no exceptions; see _candidate_valid)."""
    results = arena.simulate(_W["venue"], u, _W["spec"], suite=_W["full_suite"])
    total = sum(r["weight"] * r["terms"]["cost"] for r in results)
    total /= max(sum(r["weight"] for r in results), 1e-9)
    slim = [{"label": r["label"], "weight": r["weight"], **r["terms"],
             "n_in": r["n_in"], "n_out": r["n_out"], "n_clipped": r["n_clipped"],
             "ledger_error": r["ledger_error"]} for r in results]
    overlap = arena.layout_overlaps(_W["venue"], arena.unpack(u, _W["venue"], _W["spec"]))
    return total, slim, overlap

def _candidate_valid(slim, overlap):
    """A candidate only counts if it has NO overlap at all -- between any
    two zones, any two pieces of furniture, or furniture and a zone
    (arena.layout_overlaps, no exceptions) -- AND every scenario in its
    suite passes sim.is_valid() -- disconnected in even one scenario (or
    over the 2% unplaced-fraction bar) disqualifies it outright, no matter
    how good its cost looks. This matters because it CAN look perfect:
    sim.appraise()'s own docstring documents the tradeoff directly -- a
    region the model thinks nobody can ever reach contributes exactly zero
    excess-density cost, since cost integrates only the density the
    simulator actually computed there. That's not a flaw in the cost
    function's math; it's exactly why `disconnected` (and layout overlap)
    are SEPARATE hard gates that have to be checked here, not folded into
    the number being minimized."""
    return not overlap and all(sim.is_valid(s) for s in slim)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--venue", default=None,
                    help="path to a .crowdsense.json to optimize; defaults to the sample fixture")
    ap.add_argument("--out", default=None,
                    help="where to write the optimized venue JSON; defaults to optimizer/optimized-venue.json")
    ap.add_argument("--progress-json", action="store_true",
                    help="also emit machine-readable NDJSON progress lines to stdout, "
                         "prefixed 'CROWDSENSE_PROGRESS ', for a caller (e.g. the editor) to parse")
    args = ap.parse_args()

    venue_path = args.venue or VENUE_PATH
    out_path = args.out or os.path.join(_HERE, "optimized-venue.json")

    def progress(stage, **fields):
        """Emits a normal, human-readable line always, plus (if requested)
        a matching NDJSON line the Electron integration can parse for a
        live progress UI without screen-scraping the human-readable text."""
        if args.progress_json:
            print("CROWDSENSE_PROGRESS " + json.dumps({"stage": stage, **fields}), flush=True)

    venue = arena.load(venue_path)
    spec = arena.build_spec(venue)
    DIM = spec.dim
    print(f"loaded venue: {venue_path}")
    print(f"movable elements: {len(spec.entries)}  ->  {DIM}-dim parameter vector")
    for e in spec.entries:
        print(f"    {e['kind']:5s} {e['id']:16s} {e['geo0']['shape']:8s}"
              f" {'extendable' if e['extendable'] else 'fixed size'}"
              f"{', removable' if e.get('removable') else ''}  ({e['n']} params)")
    progress("loaded", movable_elements=len(spec.entries), dim=DIM)

    rng = np.random.default_rng(0)
    u0 = arena.default_u(venue, spec)

    # ---- 1. data generation, on the real simulator ----
    # This is the step that actually dominates wall-clock time (see
    # docs/OPTIMIZER.md's Performance section), so it's also the one place
    # a caller-visible progress bar most needs real granularity instead of
    # sitting at one number for the whole run then jumping. `pool.imap`
    # (not `pool.map`) yields each result as soon as it's ready, in the
    # same order as the input -- same total cost as `pool.map`, but lets
    # us report "done/total" as the batch actually completes rather than
    # only once at the very end.
    print(f"\ngenerating training data from the simulator "
          f"({N_TRAIN + N_TEST} runs on {N_WORKERS} workers) ...")
    total_samples = N_TRAIN + N_TEST
    progress("training_data_start", n_train=N_TRAIN, n_test=N_TEST, n_workers=N_WORKERS)
    X = np.vstack([u0[None, :], rng.uniform(0, 1, size=(N_TRAIN - 1, DIM))])
    X_test = rng.uniform(0, 1, size=(N_TEST, DIM))
    t0 = time.time()
    # Report roughly every 2.5% of the batch to a caller (fine enough to
    # look smooth without flooding IPC/stdout), and roughly every 5% to a
    # plain terminal (a carriage-return progress line, in place).
    json_every = max(1, total_samples // 40)
    term_every = max(1, total_samples // 20)
    y = np.empty(N_TRAIN)
    y_test = np.empty(N_TEST)
    done = 0
    with Pool(N_WORKERS, initializer=_init_worker, initargs=(venue_path,)) as pool:
        for i, val in enumerate(pool.imap(_score_train, list(X), chunksize=2)):
            y[i] = val
            done += 1
            if done % json_every == 0 or done == total_samples:
                progress("training_data_progress", done=done, total=total_samples)
            if done % term_every == 0 or done == total_samples:
                print(f"\r  {done}/{total_samples} samples ({100*done/total_samples:.0f}%)...", end="", flush=True)
        for i, val in enumerate(pool.imap(_score_train, list(X_test), chunksize=2)):
            y_test[i] = val
            done += 1
            if done % json_every == 0 or done == total_samples:
                progress("training_data_progress", done=done, total=total_samples)
            if done % term_every == 0 or done == total_samples:
                print(f"\r  {done}/{total_samples} samples ({100*done/total_samples:.0f}%)...", end="", flush=True)
    print(f"\r  {N_TRAIN} samples in {time.time()-t0:.0f}s, cost range [{y.min():.3f}, {y.max():.3f}]" + " " * 10)
    progress("training_data_done", seconds=time.time() - t0, cost_min=float(y.min()), cost_max=float(y.max()))

    # ---- 2. train ----
    print("\ntraining surrogate ...")
    progress("surrogate_training_start")
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
    progress("surrogate_training_done", mae=mae, r2=r2, rank_corr=float(rank), trusted=bool(trust))

    # ---- 3. optimise through the frozen surrogate ----
    print("\nsearching for a better layout (gradient descent on the surrogate) ...")
    progress("search_start")
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
    progress("verify_start", n_candidates=len(picks) + 2)
    to_verify = [u0] + [c for _, c in picks] + [best_random]
    labels = ["original"] + [f"surrogate #{i+1}" for i in range(len(picks))] + ["best sampled"]
    t0 = time.time()
    verified = [None] * len(to_verify)
    with Pool(min(N_WORKERS, len(to_verify)), initializer=_init_worker,
              initargs=(venue_path,)) as pool:
        # Only a handful of candidates here, so report every one (each can
        # still take a few seconds -- a real scenario suite, not a cheap
        # training-suite score) rather than throttling like the batch above.
        for i, result in enumerate(pool.imap(_score_full, to_verify)):
            verified[i] = result
            progress("verify_progress", done=i + 1, total=len(to_verify))
            print(f"\r  {i + 1}/{len(to_verify)} candidates verified...", end="", flush=True)
    print(f"\r  done in {time.time()-t0:.0f}s" + " " * 15)
    progress("verify_done", seconds=time.time() - t0)

    valid_flags = [_candidate_valid(slim, overlap) for _, slim, overlap in verified]
    print(f"\n{'candidate':16s} {'real cost':>10s} {'valid':>6s}   verdict")
    base_cost = verified[0][0]
    for lab, (cost, _, overlap), valid in zip(labels, verified, valid_flags):
        delta = 100 * (base_cost - cost) / base_cost if base_cost else 0.0
        note = "baseline" if lab == "original" else (f"{delta:+.1f}% vs original")
        if overlap:
            note += " [overlap]"
        print(f"{lab:16s} {cost:10.4f} {'yes' if valid else 'NO':>6s}   {note}")

    # SAFETY NET: pick the best VERIFIED candidate, never the surrogate's
    # word -- AND never a candidate that only "wins" by stranding part of
    # the crowd somewhere the model can't see (disconnected, or over the 2%
    # unplaced bar), or by letting two elements (zones or furniture) occupy
    # the same footprint. Sorting by (invalid, cost) puts every valid
    # candidate ahead of every invalid one, cost only breaking ties within
    # each group -- an invalid candidate's cost, however low, never
    # overrides validity.
    order = sorted(range(len(verified)), key=lambda i: (not valid_flags[i], verified[i][0]))
    win = order[0]
    best_u, (best_cost, best_break, _) = to_verify[win], verified[win]
    invalid_labels = [lab for lab, valid in zip(labels, valid_flags) if not valid]
    if invalid_labels:
        print(f"\n  disqualified regardless of cost (disconnected crowd, >2% unplaced, "
              f"or two elements overlapping): {', '.join(invalid_labels)}")
    if not valid_flags[win]:
        print("  WARNING: even the best candidate failed validity -- including the original "
              "layout. The venue itself likely needs attention (an entrance/exit that can't "
              "reach a populated zone, or two elements that already overlap as drawn -- e.g. "
              "a pillar sitting inside a zone); shipping it anyway since nothing else "
              "qualifies.")
    elif win == 0:
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
    _, base_break, _ = verified[0]
    print(f"\n{'scenario':26s} {'cost before':>11s} {'cost after':>11s} "
          f"{'peak rho':>9s} {'T95':>9s} {'danger':>8s}  disc.")
    for b, a in zip(base_break, best_break):
        t95 = f"{a['T95']:.0f}s" + ("" if a["T95_reached"] else "*")
        disc = "yes" if a["disconnected"] else ""
        print(f"{b['label']:26s} {b['cost']:11.4f} {a['cost']:11.4f} "
              f"{a['peak_rho']:9.2f} {t95:>9s} {a['danger_frac']:8.3f}  {disc}")
    print("  * T95 not reached inside the horizon")
    print("  disc. = this scenario's crowd was partly disconnected from its target "
          "(see the validity check above; a plain low cost here can't be trusted alone)")

    worst = max(abs(s["ledger_error"]) for s in best_break)
    clipped = max(s["n_clipped"] / max(s["n_in"], 1) for s in best_break)
    print(f"\nledger check (4.7): worst error {worst:.2e}   worst clipped fraction {clipped:.2%}"
          f"   {'OK' if clipped < 0.01 else 'INVALID -- over the 1% bar'}")
    print(f"layout overlap check: {'OVERLAP -- INVALID' if verified[win][2] else 'none -- OK'}")

    np.savez(os.path.join(_HERE, "pipeline_result.npz"), u0=u0, u1=best_u)
    arena.write_sim_result(venue, u0, best_u, base_break, best_break, spec, out_path)
    print(f"\nwrote {out_path}")
    print("(a full venue file -- open it in the CrowdSense editor to see the optimized layout;")
    print(" results also live under its top-level \"simulation\" key)")
    progress("done", out_path=out_path, winner=labels[win], improved=win != 0,
              base_cost=base_cost, best_cost=best_cost, valid=bool(valid_flags[win]))


if __name__ == "__main__":
    main()
