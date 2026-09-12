"""
run_pipeline.py -- the whole ML loop, start to finish, on the real venue file.

    1. generate training data by calling the (placeholder) simulator many times
    2. train the surrogate to imitate it
    3. optimise THROUGH the frozen surrogate  <-- this is "the ML"
    4. VALIDATE the winner on the real simulator, every time, no exceptions
       (a surrogate that's wrong in a way that looks like an improvement is
       the single most likely way this project embarrasses you on stage)
"""

import os
import numpy as np
from arena import load, default_u, score, objective, DIM, write_result
from surrogate import Surrogate, gradient_search

rng = np.random.default_rng(0)

# when this file lives in optimizer/, the canonical fixture is the one
# your teammates committed at examples/sample-venue.json -- prefer that,
# fall back to a local copy so this script also runs standalone.
_HERE = os.path.dirname(os.path.abspath(__file__))
_CANDIDATES = [
    os.path.join(_HERE, "..", "examples", "sample-venue.json"),
    os.path.join(_HERE, "sample-venue.json"),
]
VENUE_PATH = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[-1])
venue = load(VENUE_PATH)
print(f"loaded venue: {VENUE_PATH}")

# ---- 1. data generation -------------------------------------------------
# swap this loop's `objective(venue, u)` call for your teammates' real
# simulator call the moment it exists. NOTHING else in this file changes.
print("generating training data from the simulator ...")
N = 900
X = rng.uniform(0, 1, size=(N, DIM))
y = np.array([objective(venue, x) for x in X])
print(f"  {N} samples, objective range [{y.min():.1f}, {y.max():.1f}]")

# held out, never trained on -- this is what "does it generalise" means
X_test = rng.uniform(0, 1, size=(150, DIM))
y_test = np.array([objective(venue, x) for x in X_test])

# ---- 2. train -------------------------------------------------------------
print("\ntraining surrogate ...")
net = Surrogate(n_in=DIM, seed=1)
net.fit(X, y, epochs=2500, lr=0.06)

pred_test = net.predict(X_test)
mae = np.mean(np.abs(pred_test - y_test))
rank_corr = np.corrcoef(np.argsort(np.argsort(pred_test)),
                         np.argsort(np.argsort(y_test)))[0, 1]
print(f"\n  held-out MAE           : {mae:.2f}")
print(f"  held-out rank corr.    : {rank_corr:.3f}   <- this is the number that matters")
print("  (near 1.0: the surrogate ranks layouts the same way the real")
print("   simulator would, even if its absolute numbers are off)")

# ---- 3. optimise through the frozen surrogate ------------------------------
print("\nsearching for a better layout (gradient descent on the surrogate) ...")
u0 = default_u(venue)                 # the ORIGINAL layout in the JSON
starts = [u0] + [rng.uniform(0, 1, DIM) for _ in range(24)]
best_u, best_pred = None, np.inf
for s in starts:
    cand = gradient_search(net, s, steps=250, lr=0.03)
    pred = net.predict(cand)[0]
    if pred < best_pred:
        best_pred, best_u = pred, cand

# ---- 4. validate on the REAL scorer, not the surrogate ---------------------
r0 = score(venue, u0)
r1 = score(venue, best_u)
real_obj_0, real_obj_1 = objective(venue, u0), objective(venue, best_u)
print(f"\nBEFORE (JSON layout)      evac {r0['evac_time']:.1f}s  pressure {r0['peak_pressure']:.3f}")
print(f"AFTER  (surrogate design) evac {r1['evac_time']:.1f}s  pressure {r1['peak_pressure']:.3f}")
print(f"surrogate PREDICTED objective : {best_pred:.1f}")
print(f"real objective on this layout : {real_obj_1:.1f}   (was {real_obj_0:.1f} before)")

# SAFETY NET: the surrogate can be fooled. If the "optimised" layout is
# actually worse on the real scorer than doing nothing, don't ship it --
# fall back to the best point you happened to sample during data generation.
if real_obj_1 >= real_obj_0:
    print("\n  surrogate's pick did NOT beat the original on the real scorer.")
    print("  falling back to the best layout seen during random sampling ...")
    fallback_i = np.argmin(y)
    if y[fallback_i] < real_obj_1:
        best_u, real_obj_1 = X[fallback_i], y[fallback_i]
        r1 = score(venue, best_u)
        print(f"  fallback layout: evac {r1['evac_time']:.1f}s  pressure {r1['peak_pressure']:.3f}"
              f"  (real objective {real_obj_1:.1f})")

imp_evac = 100 * (r0["evac_time"] - r1["evac_time"]) / r0["evac_time"]
imp_pres = 100 * (r0["peak_pressure"] - r1["peak_pressure"]) / r0["peak_pressure"]
print(f"\nevac time  : {imp_evac:+.0f}%")
print(f"peak pressure: {imp_pres:+.0f}%")

np.savez("pipeline_result.npz", u0=u0, u1=best_u)

out_path = os.path.join(_HERE, "optimized-venue.json")
write_result(venue, u0, best_u, r0, r1, out_path)
print(f"\nwrote {out_path}")
print("(a full venue file -- open it in the CrowdSense editor to see the optimized layout;")
print(" results also live under its top-level \"simulation\" key)")
