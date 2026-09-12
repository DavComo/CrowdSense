"""run_multi_venue_pipeline.py -- train the U-Net across many DIFFERENT
venues (design doc 6.2's actual point: one model, a whole distribution of
room shapes) and check it on venues it has never seen at all.

IMPORTANT distinction from run_unet_pipeline.py's own hold-out: this splits
by VENUE IDENTITY, not by sample. unet.train()'s built-in holdout shuffles
individual samples, so with 2 layouts per venue, one layout of a room could
land in "train" and the other in "test" -- that tests generalizing to a new
FURNITURE ARRANGEMENT of an already-seen room, which is a different (and
easier) claim than generalizing to an unseen ROOM SHAPE. This script holds
out entire venues -- every sample from a held-out venue is unseen in every
sense during training.

    python3 factory_multi.py --n 700 --layouts-per-venue 2   # once, ~10 min
    python3 run_multi_venue_pipeline.py
"""
import argparse
import os
import time
import numpy as np
import torch

import unet

_HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(_HERE, "data", "shard_multi_venue.npz"))
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--venue-holdout", type=float, default=0.15,
                    help="fraction of DISTINCT VENUES (not samples) held out entirely")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    if not os.path.exists(args.data):
        raise SystemExit(f"no data at {args.data}\nrun:  python3 factory_multi.py --n 700")
    d = np.load(args.data, allow_pickle=True)
    X, Ym, Ys, kind = d["X"], d["Y_maps"], d["Y_scal"], d["venue_kind"]
    print(f"dataset: {len(X)} samples, channels {X.shape[1]}, grid {X.shape[2]}x{X.shape[3]}")
    print(f"  archetypes: {dict(zip(*np.unique(kind, return_counts=True)))}")
    print(f"  cost range [{Ys[:,0].min():.3f}, {Ys[:,0].max():.3f}]  mean {Ys[:,0].mean():.3f}")

    # Group samples by VENUE, not by row. Every sample from the same venue
    # (all its layouts x scenarios) shares an identical walkable mask
    # (channel 0) -- that's a stable enough fingerprint to group by without
    # threading a venue-id through the factory's .npz format.
    fingerprints = X[:, 0].reshape(len(X), -1)
    _, venue_id = np.unique(fingerprints, axis=0, return_inverse=True)
    n_venues = venue_id.max() + 1
    print(f"  {n_venues} distinct venues by walkable-mask fingerprint "
          f"({len(X)/n_venues:.1f} samples/venue on average)")

    rng = np.random.default_rng(args.seed)
    venue_perm = rng.permutation(n_venues)
    n_test_venues = max(int(n_venues * args.venue_holdout), 5)
    test_venues = set(venue_perm[:n_test_venues].tolist())
    train_mask = np.array([v not in test_venues for v in venue_id])
    print(f"  holding out {n_test_venues} ENTIRE venues "
          f"({int(train_mask.sum())} train samples / {int((~train_mask).sum())} test samples, "
          f"never seen in any form during training)")

    # ---- train on the remaining venues only ----
    print(f"\ntraining U-Net on {n_venues - n_test_venues} venues ({args.epochs} epochs) ...")
    t0 = time.time()
    surr, r2_sample, rank_sample = unet.train(
        None, X[train_mask], Ym[train_mask], Ys[train_mask],
        epochs=args.epochs, holdout=0.1, seed=args.seed)
    print(f"  trained in {time.time()-t0:.0f}s")
    print(f"  (in-distribution held-out samples, same venues as training: "
          f"R^2 cost {r2_sample['cost']:.3f}, rank corr {rank_sample:.3f})")

    # ---- the real test: venues NEVER seen in any form ----
    net = surr.net.to(unet.DEVICE); net.eval()
    Xt = torch.tensor(X[~train_mask], dtype=torch.float32)
    Ymt = Ym[~train_mask]
    Yst_raw = Ys[~train_mask]
    with torch.no_grad():
        maps_pred, scal_pred = net(Xt.to(unet.DEVICE))
    scal_pred = (scal_pred.cpu().numpy() * unet_y_std(surr) + unet_y_mean(surr))
    cost_pred, cost_true = scal_pred[:, 0], Yst_raw[:, 0]
    ss_res = float(((cost_pred - cost_true) ** 2).sum())
    ss_tot = float(((cost_true - cost_true.mean()) ** 2).sum())
    r2_venue = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    rank_venue = float(np.corrcoef(np.argsort(np.argsort(cost_pred)),
                                   np.argsort(np.argsort(cost_true)))[0, 1])
    peak_pred = maps_pred[:, 0].clamp(0, 1).cpu().numpy()
    peak_true = Ymt[:, 0]
    ss_res_m = float(((peak_pred - peak_true) ** 2).sum())
    ss_tot_m = float(((peak_true - peak_true.mean()) ** 2).sum())
    r2_map = 1 - ss_res_m / ss_tot_m if ss_tot_m > 0 else float("nan")

    print(f"\n=== generalization to {n_test_venues} venues NEVER SEEN in any form ===")
    print(f"  R^2 on cost               : {r2_venue:.3f}")
    print(f"  rank correlation on cost  : {rank_venue:.3f}")
    print(f"  R^2 on the peak density map: {r2_map:.3f}")
    print(f"  design doc 6.4 guardrail (R^2 > 0.7): "
          f"{'PASS -- generalizes to unseen room shapes' if r2_venue > 0.7 else 'FAIL -- does not yet generalize to unseen shapes'}")

    out_path = os.path.join(_HERE, "unet_surrogate_multi_venue.pt")
    torch.save(net.state_dict(), out_path)
    np.savez(os.path.join(_HERE, "multi_venue_norm.npz"),
             y_mean=unet_y_mean(surr), y_std=unet_y_std(surr))
    print(f"\nwrote {out_path}")


def unet_y_mean(surr):
    return surr.y_mean.cpu().numpy()


def unet_y_std(surr):
    return surr.y_std.cpu().numpy()


if __name__ == "__main__":
    main()
