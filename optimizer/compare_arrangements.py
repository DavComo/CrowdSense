"""compare_arrangements.py -- same venue, same doors, N different random
arrangements of ONLY the movable furniture. One peak-density heatmap per
arrangement, so you can see by eye how much the hazard map moves around
just from rearranging the malleable objects -- this is the actual search
space the optimizer is climbing down.

    python3 compare_arrangements.py --venue path/to/your.crowdsense.json --n 6
"""
import argparse
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.colors import LinearSegmentedColormap

import arena, sim

_HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--venue", default=None)
ap.add_argument("--scenario", default="evacuation", choices=list(sim.SCENARIOS))
ap.add_argument("--n", type=int, default=6)
ap.add_argument("--seed", type=int, default=1)
args = ap.parse_args()

VENUE_PATH = args.venue or arena.default_venue_path(_HERE)
STEM = arena.venue_stem(VENUE_PATH)
venue = arena.load(VENUE_PATH)
spec = arena.build_spec(venue)
MOVABLE_IDS = {e["id"] for e in spec.entries}
horizon = arena.SCENARIO_HORIZONS.get(args.scenario, sim.HORIZON)
rng = np.random.default_rng(args.seed)

_stops = [(0.0, "#ffffff"), (sim.RHO_SAFE / sim.RHO_MAX, "#f5b942"),
          (min(sim.RHO_D / sim.RHO_MAX, 0.99), "#c8102e"), (1.0, "#3a0008")]
CMAP = LinearSegmentedColormap.from_list("crowd", _stops)


def _draw_geo(ax, geo, color, alpha, lw):
    if geo["shape"] == "rect":
        ax.add_patch(patches.Rectangle((geo["x"], geo["y"]), geo["w"], geo["h"],
                     facecolor=color, edgecolor="black", alpha=alpha, lw=lw, zorder=2))
    elif geo["shape"] == "circle":
        ax.add_patch(patches.Circle((geo["cx"], geo["cy"]), geo["r"],
                     facecolor=color, edgecolor="black", alpha=alpha, lw=lw, zorder=2))
    elif geo["shape"] in ("line", "polygon"):
        xs = [p["x"] for p in geo["points"]]; ys = [p["y"] for p in geo["points"]]
        if geo["shape"] == "polygon":
            ax.fill(xs + [xs[0]], ys + [ys[0]], color=color, alpha=alpha, zorder=2)
        else:
            ax.plot(xs, ys, color=color, lw=max(lw, 2.5), zorder=2)


def render(ax, u, title):
    movable = arena.unpack(u, venue, spec)
    geo = arena._effective_geo(venue, movable)
    vg = sim.Venue(venue, movable, spec.room)
    r = sim.run(vg, args.scenario, horizon=horizon)
    terms = sim.appraise(r)

    rx0, ry0, rx1, ry1 = spec.room
    H, W = vg.walkable.shape
    extent = [rx0, rx0 + W * vg.dx, ry0 + H * vg.dx, ry0]
    field = np.where(vg.walkable, r["peak_rho"], np.nan)
    ax.imshow(field, extent=extent, origin="upper", cmap=CMAP, vmin=0, vmax=sim.RHO_MAX, interpolation="nearest")

    for w in venue.get("walls", []):
        mv = w["id"] in MOVABLE_IDS
        _draw_geo(ax, geo[w["id"]], "#c98f4f" if mv else "#555", 0.95 if mv else 1.0, 1.2)
    for z in venue.get("zones", []):
        _draw_geo(ax, geo[z["id"]], z.get("color", "#8b7fe0"), 0.0, 0.9)   # outline only
    for p in venue.get("points", []):
        g = geo[p["id"]]
        c = "#5bb98c" if p.get("type") == "entrance" else "#e0564f"
        ax.scatter(g["x"], g["y"], s=70, color=c, edgecolor="black", zorder=5, marker="s")

    ax.set_title(f"{title}\ncost {terms['cost']:.3f}   peak {terms['peak_rho']:.1f}/m²", fontsize=9)
    ax.set_xlim(rx0, rx1); ax.set_ylim(ry1, ry0); ax.set_aspect("equal"); ax.axis("off")
    return terms["cost"]


u0 = arena.default_u(venue, spec)
layouts = [("ORIGINAL (as drawn)", u0)] + \
          [(f"random #{i+1}", rng.uniform(0, 1, spec.dim)) for i in range(args.n - 1)]

ncols = 3
nrows = -(-len(layouts) // ncols)
fig, axes = plt.subplots(nrows, ncols, figsize=(4.3 * ncols, 4.0 * nrows))
axes = np.atleast_2d(axes)
costs = []
for i, (label, u) in enumerate(layouts):
    ax = axes[i // ncols, i % ncols]
    costs.append(render(ax, u, label))
for i in range(len(layouts), nrows * ncols):
    axes[i // ncols, i % ncols].axis("off")

sm = plt.cm.ScalarMappable(cmap=CMAP, norm=plt.Normalize(0, sim.RHO_MAX))
cb = fig.colorbar(sm, ax=axes.ravel().tolist(), fraction=0.02, pad=0.01)
cb.set_label("peak density (people/m²)", fontsize=8)

fig.suptitle(f"Same venue, same doors, {len(layouts)} different arrangements of the movable furniture\n"
             f"({args.scenario}) -- cost ranges {min(costs):.3f} to {max(costs):.3f} "
             f"just from where the furniture sits", fontsize=11, weight="bold")
plt.tight_layout(rect=[0, 0, 1, 0.93])
out = os.path.join(_HERE, f"arrangements_{args.scenario}_{STEM}.png")
plt.savefig(out, dpi=130)
print(f"wrote {out}")
print("costs:", [f"{c:.3f}" for c in costs])
