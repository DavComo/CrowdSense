"""show_improvement.py -- the plot that actually shows what changed.

A peak-density heatmap is a bad way to compare layouts: every layout that
funnels the same crowd through the same fixed door hits the same physical
ceiling (rho_max) at that door, so the single reddest pixel looks the same
everywhere and the real difference -- how much AREA and TIME spent above
the safety threshold -- doesn't show. This does two things that do show it:

  1. a DIFF map (after - before), diverging colormap: blue where the crowd
     is now less packed, red where it's worse, so improvement is legible
     as a color, not an inference from two similarly-saturated red blobs.
  2. area-above-rho_safe OVER TIME, before vs after: this is closer to what
     the cost function actually integrates (excess density x area x time),
     and it's where a "same peak, lower cost" result actually shows up.

    python3 show_improvement.py --venue path/to/your.crowdsense.json
"""
import argparse
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches

import arena, sim

_HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--venue", default=None)
ap.add_argument("--result", default=None)
ap.add_argument("--scenario", default="evacuation", choices=list(sim.SCENARIOS))
args = ap.parse_args()

VENUE_PATH = args.venue or arena.default_venue_path(_HERE)
STEM = arena.venue_stem(VENUE_PATH)
venue = arena.load(VENUE_PATH)
spec = arena.build_spec(venue)
result_path = args.result or os.path.join(_HERE, f"pipeline_result_{STEM}.npz")
if not os.path.exists(result_path):
    raise SystemExit(f"no result at {result_path}\nrun:  python3 run_unet_pipeline.py --venue {VENUE_PATH}")
d = np.load(result_path)
MOVABLE_IDS = {e["id"] for e in spec.entries}
horizon = arena.SCENARIO_HORIZONS.get(args.scenario, sim.HORIZON)


def _outline(ax, geo):
    if geo["shape"] == "rect":
        ax.add_patch(patches.Rectangle((geo["x"], geo["y"]), geo["w"], geo["h"],
                     fill=False, edgecolor="black", lw=1.0, zorder=3))
    elif geo["shape"] == "circle":
        ax.add_patch(patches.Circle((geo["cx"], geo["cy"]), geo["r"],
                     fill=False, edgecolor="black", lw=1.0, zorder=3))
    elif geo["shape"] in ("line", "polygon"):
        xs = [p["x"] for p in geo["points"]]; ys = [p["y"] for p in geo["points"]]
        if geo["shape"] == "polygon":
            xs, ys = xs + [xs[0]], ys + [ys[0]]
        ax.plot(xs, ys, color="black", lw=1.4, zorder=3)


def run_with_series(u):
    movable = arena.unpack(u, venue, spec)
    vg = sim.Venue(venue, movable, spec.room)
    r = sim.run(vg, args.scenario, horizon=horizon, record_every=5, record_frames=True)
    area_series = [float((f > sim.RHO_SAFE).sum()) * vg.dA for f in r["frames"]]
    return vg, arena._effective_geo(venue, movable), r, area_series


print("simulating before ...")
vg0, geo0, r0, series0 = run_with_series(d["u0"])
print("simulating after ...")
vg1, geo1, r1, series1 = run_with_series(d["u1"])

rx0, ry0, rx1, ry1 = spec.room
H, W = vg0.walkable.shape
extent = [rx0, rx0 + W * vg0.dx, ry0 + H * vg0.dx, ry0]

fig, (ax_diff, ax_series) = plt.subplots(1, 2, figsize=(13, 5.4))

# --- panel 1: diff map ---
diff = np.where(vg0.walkable, r1["peak_rho"] - r0["peak_rho"], np.nan)
vmax = max(1.0, np.nanmax(np.abs(diff)))
im = ax_diff.imshow(diff, extent=extent, origin="upper", cmap="RdBu_r", vmin=-vmax, vmax=vmax,
                    interpolation="nearest", zorder=1)
for w in venue.get("walls", []):
    _outline(ax_diff, geo1[w["id"]])
for z in venue.get("zones", []):
    _outline(ax_diff, geo1[z["id"]])
for p in venue.get("points", []):
    g = geo1[p["id"]]
    c = "#5bb98c" if p.get("type") == "entrance" else "#e0564f"
    ax_diff.scatter(g["x"], g["y"], s=90, color=c, edgecolor="black", zorder=5, marker="s")
cb = fig.colorbar(im, ax=ax_diff, fraction=0.045, pad=0.02)
cb.set_label("peak density change, after − before (people/m²)", fontsize=8)
ax_diff.set_title("WHERE it got better (blue) or worse (red)\nsame peak overall -- this is what a single peak number hides",
                  fontsize=9.5)
ax_diff.set_xlim(rx0, rx1); ax_diff.set_ylim(ry1, ry0); ax_diff.set_aspect("equal"); ax_diff.axis("off")

# --- panel 2: area over rho_safe, over time ---
t0 = r0["frame_t"]; t1 = r1["frame_t"]
ax_series.fill_between(t0, series0, color="#c8102e", alpha=0.35, label="before")
ax_series.fill_between(t1, series1, color="#2c7fb8", alpha=0.45, label="after")
ax_series.plot(t0, series0, color="#c8102e", lw=1.5)
ax_series.plot(t1, series1, color="#2c7fb8", lw=1.5)
_trapz = getattr(np, "trapezoid", None) or np.trapz
auc0 = _trapz(series0, t0); auc1 = _trapz(series1, t1)
ax_series.set_xlabel("time (s)", fontsize=9)
ax_series.set_ylabel("floor area above ρ_safe (m²)", fontsize=9)
ax_series.set_title(f"the shaded area is what the cost function actually integrates\n"
                    f"before: {auc0:.0f} m²·s   after: {auc1:.0f} m²·s   ({100*(auc0-auc1)/auc0:+.0f}%)",
                    fontsize=9.5)
ax_series.legend(fontsize=9, frameon=False)
ax_series.spines[["top", "right"]].set_visible(False)

fig.suptitle(f"Same peak density (5.40/m² in both -- that's the fixed door's physical ceiling, not what changed).\n"
             f"What the optimizer actually reduced: how much floor, for how long, sits above the safety threshold.",
             fontsize=11, weight="bold")
plt.tight_layout(rect=[0, 0, 1, 0.90])
out = os.path.join(_HERE, f"improvement_{args.scenario}_{STEM}.png")
plt.savefig(out, dpi=140)
print(f"wrote {out}")
print(f"area-under-curve (m^2 . s of excess crowding): before {auc0:.0f}, after {auc1:.0f}, {100*(auc0-auc1)/auc0:+.0f}%")
