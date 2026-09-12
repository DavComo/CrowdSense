"""show_unet.py -- does the U-Net actually predict the simulator's density map?

Three columns: what the simulator produced, what the U-Net predicted for the
same layout, and the error. One row per scenario. This is the slide that says
the surrogate learned the physics rather than memorizing a mean.

    python3 show_unet.py --venue path/to/your.crowdsense.json
"""
import argparse
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import torch

import arena, sim, unet, factory

_HERE = os.path.dirname(os.path.abspath(__file__))
_ap = argparse.ArgumentParser()
_ap.add_argument("--venue", default=None)
_args = _ap.parse_args()

venue_path = _args.venue or arena.default_venue_path(_HERE)
STEM = arena.venue_stem(venue_path)
venue = arena.load(venue_path)
spec = arena.build_spec(venue)
raster = unet.Raster(venue, spec)

data_path = os.path.join(_HERE, "data", f"shard_{STEM}.npz")
surrogate_path = os.path.join(_HERE, f"unet_surrogate_{STEM}.pt")
if not os.path.exists(data_path) or not os.path.exists(surrogate_path):
    raise SystemExit(f"missing {data_path if not os.path.exists(data_path) else surrogate_path}\n"
                     f"run:  python3 factory.py --venue {venue_path} --n 700 && "
                     f"python3 run_unet_pipeline.py --venue {venue_path}")
d = np.load(data_path, allow_pickle=True)
X, Ym, Ys = d["X"], d["Y_maps"], d["Y_scal"]
net = unet.UNet().to(unet.DEVICE)
net.load_state_dict(torch.load(surrogate_path, map_location=unet.DEVICE))
net.eval()

# a layout the net never trained on: the factory holds out the same split
rng = np.random.default_rng(0)
perm = rng.permutation(len(X))
n_test = max(int(len(X) * 0.15), 8)
test_idx = perm[:n_test]
# pick one layout (3 consecutive scenario rows share a layout)
pick = int(test_idx[0]) // len(unet.SCENARIOS) * len(unet.SCENARIOS)

H0, W0 = raster.H0, raster.W0
fig, axes = plt.subplots(len(unet.SCENARIOS), 3, figsize=(12, 3.4 * len(unet.SCENARIOS)))
for row, s in enumerate(unet.SCENARIOS):
    i = pick + row
    with torch.no_grad():
        maps, scal = net(torch.tensor(X[i])[None].to(unet.DEVICE))
    truth = Ym[i, 0, :H0, :W0] * sim.RHO_MAX
    pred = maps[0, 0, :H0, :W0].clamp(0, 1).cpu().numpy() * sim.RHO_MAX
    walk = X[i, 0, :H0, :W0] > 0.5
    truth = np.where(walk, truth, np.nan); pred = np.where(walk, pred, np.nan)
    err = pred - truth

    for col, (img, title, kw) in enumerate([
            (truth, f"simulator — {s}", dict(cmap="magma_r", vmin=0, vmax=sim.RHO_MAX)),
            (pred, f"U-Net prediction — {s}", dict(cmap="magma_r", vmin=0, vmax=sim.RHO_MAX)),
            (err, "error (pred − sim)", dict(cmap="coolwarm", vmin=-2, vmax=2))]):
        ax = axes[row, col]
        im = ax.imshow(img, origin="upper", **kw)
        ax.set_title(title, fontsize=9)
        ax.axis("off")
        fig.colorbar(im, ax=ax, fraction=0.035, pad=0.02)
    rmse = float(np.sqrt(np.nanmean(err ** 2)))
    axes[row, 2].text(0.02, 0.02, f"RMSE {rmse:.2f} /m²", transform=axes[row, 2].transAxes,
                      fontsize=8, bbox=dict(fc="white", alpha=0.8, lw=0))

fig.suptitle("U-Net surrogate vs the Hughes simulator — peak density, held-out layout\n"
             "(the surrogate is what the search descends through; every candidate is re-simulated before it counts)",
             fontsize=11, weight="bold")
plt.tight_layout(rect=[0, 0, 1, 0.94])
out = os.path.join(_HERE, f"unet_vs_sim_{STEM}.png")
plt.savefig(out, dpi=140)
print(f"wrote {out}")
