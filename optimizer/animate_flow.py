"""animate_flow.py -- an actual movie of the simulation: density evolving
second by second, BEFORE and AFTER side by side, same venue, same scenario,
only the movable furniture different.

    python3 animate_flow.py --venue path/to/your.crowdsense.json --scenario evacuation
"""
import argparse
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.animation import FuncAnimation, PillowWriter
from matplotlib.colors import LinearSegmentedColormap

import arena, sim

_HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--venue", default=None)
ap.add_argument("--result", default=None, help="pipeline_result_<venue>.npz; defaults to that path")
ap.add_argument("--scenario", default="evacuation", choices=list(sim.SCENARIOS))
ap.add_argument("--fps", type=int, default=12)
ap.add_argument("--record-every", type=int, default=5, help="sim steps between frames (5 = every 0.5s)")
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

_stops = [(0.0, "#ffffff"), (sim.RHO_SAFE / sim.RHO_MAX, "#f5b942"),
          (min(sim.RHO_D / sim.RHO_MAX, 0.99), "#c8102e"), (1.0, "#3a0008")]
CMAP = LinearSegmentedColormap.from_list("crowd", _stops)


def _draw_geo(ax, geo, color, alpha, lw, label=None, z=2):
    if geo["shape"] == "rect":
        ax.add_patch(patches.Rectangle((geo["x"], geo["y"]), geo["w"], geo["h"], facecolor=color,
                                       edgecolor="black", alpha=alpha, lw=lw, label=label, zorder=z))
    elif geo["shape"] == "circle":
        ax.add_patch(patches.Circle((geo["cx"], geo["cy"]), geo["r"], facecolor=color,
                                    edgecolor="black", alpha=alpha, lw=lw, label=label, zorder=z))
    elif geo["shape"] in ("line", "polygon"):
        xs = [p["x"] for p in geo["points"]]; ys = [p["y"] for p in geo["points"]]
        if geo["shape"] == "polygon":
            ax.fill(xs + [xs[0]], ys + [ys[0]], color=color, alpha=alpha, label=label, zorder=z)
        else:
            ax.plot(xs, ys, color=color, lw=max(lw, 2.5), solid_capstyle="round", label=label, zorder=z)


def draw_static(ax, geo):
    seen = set()
    for w in venue.get("walls", []):
        mv = w["id"] in MOVABLE_IDS
        lab = "movable wall" if mv else "fixed wall"
        _draw_geo(ax, geo[w["id"]], "#c98f4f" if mv else "#555", 0.95, 1.2,
                  lab if lab not in seen else None); seen.add(lab)
    for z in venue.get("zones", []):
        mv = z["id"] in MOVABLE_IDS
        lab = f"{z.get('type', 'zone')} ({'movable' if mv else 'fixed'})"
        _draw_geo(ax, geo[z["id"]], z.get("color", "#8b7fe0"), 0.0, 0.8,
                  lab if lab not in seen else None); seen.add(lab)   # alpha=0: outline only, density map shows the fill
    for p in venue.get("points", []):
        g = geo[p["id"]]
        c = "#5bb98c" if p.get("type") == "entrance" else "#e0564f"
        ax.scatter(g["x"], g["y"], s=110, color=c, edgecolor="black", zorder=5, marker="s")
        ax.annotate(p.get("name", p["id"]), (g["x"], g["y"]), fontsize=6.5, ha="center",
                    xytext=(0, 7), textcoords="offset points", zorder=6)


def simulate(u):
    movable = arena.unpack(u, venue, spec)
    vg = sim.Venue(venue, movable, spec.room)
    r = sim.run(vg, args.scenario, horizon=horizon, record_every=args.record_every, record_frames=True)
    return vg, arena._effective_geo(venue, movable), r


print(f"simulating BEFORE ({args.scenario}) ...")
vg0, geo0, r0 = simulate(d["u0"])
print(f"simulating AFTER  ({args.scenario}) ...")
vg1, geo1, r1 = simulate(d["u1"])

n_frames = min(len(r0["frames"]), len(r1["frames"]))
print(f"{n_frames} frames, venue {vg0.walkable.shape}, ~{n_frames/args.fps:.0f}s of playback")

# running peak-so-far, precomputed once (not inside the per-frame callback)
run_peak0 = np.maximum.accumulate([float(np.nanmax(f)) for f in r0["frames"]])
run_peak1 = np.maximum.accumulate([float(np.nanmax(f)) for f in r1["frames"]])

fig, axes = plt.subplots(1, 2, figsize=(13, 6.2))
rx0, ry0, rx1, ry1 = spec.room
extents = []
for ax, geo, vg, title in [(axes[0], geo0, vg0, "BEFORE"), (axes[1], geo1, vg1, "AFTER")]:
    H, W = vg.walkable.shape
    extent = [rx0, rx0 + W * vg.dx, ry0 + H * vg.dx, ry0]
    extents.append(extent)
    draw_static(ax, geo)
    ax.set_xlim(rx0, rx1); ax.set_ylim(ry1, ry0); ax.set_aspect("equal"); ax.axis("off")
axes[0].legend(loc="lower left", fontsize=6, frameon=True, framealpha=0.85, ncol=2)

im0 = axes[0].imshow(np.where(vg0.walkable, r0["frames"][0], np.nan), extent=extents[0], origin="upper",
                     cmap=CMAP, vmin=0, vmax=sim.RHO_MAX, interpolation="nearest", zorder=1)
im1 = axes[1].imshow(np.where(vg1.walkable, r1["frames"][0], np.nan), extent=extents[1], origin="upper",
                     cmap=CMAP, vmin=0, vmax=sim.RHO_MAX, interpolation="nearest", zorder=1)
t0 = axes[0].set_title("", fontsize=10)
t1 = axes[1].set_title("", fontsize=10)
sm = plt.cm.ScalarMappable(cmap=CMAP, norm=plt.Normalize(0, sim.RHO_MAX))
cb = fig.colorbar(sm, ax=axes.tolist(), fraction=0.025, pad=0.02)
cb.set_label("density (people/m²)", fontsize=8)
cb.ax.axhline(sim.RHO_SAFE, color="#7a0000", lw=1.2)
cb.ax.text(1.4, sim.RHO_SAFE, f" ρ_safe={sim.RHO_SAFE}", va="center", fontsize=7, color="#7a0000")
fig.suptitle(f"{sim.SCENARIOS[args.scenario]}\nsame venue, same doors -- only the movable furniture differs",
             fontsize=11, weight="bold")


def update(i):
    i0 = min(i, len(r0["frames"]) - 1); i1 = min(i, len(r1["frames"]) - 1)
    im0.set_data(np.where(vg0.walkable, r0["frames"][i0], np.nan))
    im1.set_data(np.where(vg1.walkable, r1["frames"][i1], np.nan))
    t = r0["frame_t"][i0]
    t0.set_text(f"BEFORE   t={t:5.1f}s   peak so far {run_peak0[i0]:.2f}/m²")
    t1.set_text(f"AFTER    t={t:5.1f}s   peak so far {run_peak1[i1]:.2f}/m²")
    return im0, im1, t0, t1


anim = FuncAnimation(fig, update, frames=n_frames, blit=False)
out = os.path.join(_HERE, f"flow_{args.scenario}_{STEM}.gif")
anim.save(out, writer=PillowWriter(fps=args.fps))
print(f"wrote {out}")
