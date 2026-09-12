"""animate_density_workflow.py -- the explicit workflow figure, but PLAYING:
density map on the left evolving frame by frame, the real metrics it's
built from on the right with a moving marker at the current instant, both
updating together. Not a bare density GIF -- every frame also shows the
numbers (peak density, area over the safety threshold, area over the
danger threshold) live, so you can watch the picture and the number that
explains it change together.

    python3 animate_density_workflow.py --venue path/to/your.crowdsense.json --scenario evacuation --u after
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
ap.add_argument("--u", choices=["before", "after"], default="after")
ap.add_argument("--result", default=None)
ap.add_argument("--scenario", default="evacuation", choices=list(sim.SCENARIOS))
ap.add_argument("--fps", type=int, default=15)
ap.add_argument("--record-every", type=int, default=5, help="sim steps between frames (5 = every 0.5s)")
ap.add_argument("--incident", default=None, choices=["attractor", "blockage"],
                help="something happens mid-run: a commotion (attractor) or a cordon (blockage)")
ap.add_argument("--incident-t", type=float, default=None, help="when it happens (s); default 1/3 into the run")
ap.add_argument("--incident-x", type=float, default=None)
ap.add_argument("--incident-y", type=float, default=None)
args = ap.parse_args()

VENUE_PATH = args.venue or arena.default_venue_path(_HERE)
STEM = arena.venue_stem(VENUE_PATH)
venue = arena.load(VENUE_PATH)
spec = arena.build_spec(venue)
MOVABLE_IDS = {e["id"] for e in spec.entries}
horizon = arena.SCENARIO_HORIZONS.get(args.scenario, sim.HORIZON)

result_path = args.result or os.path.join(_HERE, f"pipeline_result_{STEM}.npz")
if os.path.exists(result_path):
    d = np.load(result_path)
    u = d["u1"] if args.u == "after" else d["u0"]
else:
    u = arena.default_u(venue, spec)
    print(f"(no {result_path} -- showing the venue's own drawn layout)")

_stops = [(0.0, "#ffffff"), (sim.RHO_SAFE / sim.RHO_MAX, "#f5b942"),
          (min(sim.RHO_D / sim.RHO_MAX, 0.99), "#c8102e"), (1.0, "#3a0008")]
CMAP = LinearSegmentedColormap.from_list("crowd", _stops)

movable = arena.unpack(u, venue, spec)
geo = arena._effective_geo(venue, movable)
vg = sim.Venue(venue, movable, spec.room)

incident = None
incident_label = ""
if args.incident:
    rx0, ry0, rx1, ry1 = spec.room
    ix = args.incident_x if args.incident_x is not None else (rx0 + rx1) / 2 + (rx1 - rx0) * 0.2
    iy = args.incident_y if args.incident_y is not None else (ry0 + ry1) / 2
    it = args.incident_t if args.incident_t is not None else horizon / 3
    label = "commotion" if args.incident == "attractor" else "cordon"
    incident = {"x": ix, "y": iy, "kind": args.incident, "t": it, "share": 0.6, "radius": 3.0, "label": label}
    incident_label = f", {label} at t={it:.0f}s"

print(f"running the real simulator: {args.scenario} on {STEM} ({args.u}){incident_label} ...")
r = sim.run(vg, args.scenario, horizon=horizon, record_every=args.record_every, record_frames=True,
           incident=incident)
frames, frame_t = r["frames"], np.array(r["frame_t"])
n_frames = len(frames)
print(f"{n_frames} frames, ~{n_frames/args.fps:.0f}s of playback")

area_safe = np.array([(f > sim.RHO_SAFE).sum() for f in frames]) * vg.dA
area_danger = np.array([(f > sim.RHO_D).sum() for f in frames]) * vg.dA
peak_so_far = np.maximum.accumulate([float(f.max()) for f in frames])

rx0, ry0, rx1, ry1 = spec.room
extent = [rx0, rx1, ry1, ry0]

fig, (ax_map, ax_graph) = plt.subplots(1, 2, figsize=(13.5, 5.6),
                                        gridspec_kw={"width_ratios": [1, 1.3]})

# ---- left: the live density map ----
im = ax_map.imshow(np.where(vg.walkable, frames[0], np.nan), extent=extent, origin="upper",
                   cmap=CMAP, vmin=0, vmax=sim.RHO_MAX, interpolation="nearest", zorder=1)
for w in venue.get("walls", []):
    g = geo[w["id"]]
    if g["shape"] == "rect":
        ax_map.add_patch(patches.Rectangle((g["x"], g["y"]), g["w"], g["h"], fill=False,
                         edgecolor="#555", lw=1.2, zorder=3))
    elif g["shape"] == "line":
        xs = [p["x"] for p in g["points"]]; ys = [p["y"] for p in g["points"]]
        ax_map.plot(xs, ys, color="#555", lw=1.4, zorder=3)
for z in venue.get("zones", []):
    g = geo[z["id"]]
    if g["shape"] == "rect":
        ax_map.add_patch(patches.Rectangle((g["x"], g["y"]), g["w"], g["h"], fill=False,
                         edgecolor="black", lw=0.9, ls="--", zorder=3))
for p in venue.get("points", []):
    g = geo[p["id"]]
    c = "#5bb98c" if p.get("type") == "entrance" else "#e0564f"
    ax_map.scatter(g["x"], g["y"], s=90, color=c, edgecolor="black", zorder=5, marker="s")
if incident:
    ax_map.scatter(incident["x"], incident["y"], s=260, facecolors="none",
                   edgecolors="#ff00ff", linewidths=2.2, zorder=6, marker="*")
    ax_map.annotate(incident["label"], (incident["x"], incident["y"]), fontsize=8, color="#ff00ff",
                    weight="bold", ha="center", xytext=(0, 10), textcoords="offset points", zorder=6)
ax_map.set_xlim(rx0, rx1); ax_map.set_ylim(ry1, ry0); ax_map.set_aspect("equal"); ax_map.axis("off")
title_map = ax_map.set_title("", fontsize=10)
cb = fig.colorbar(im, ax=ax_map, fraction=0.045, pad=0.02)
cb.set_label("density (people/m²)", fontsize=8)
cb.ax.axhline(sim.RHO_SAFE, color="#7a0000", lw=1.1)

# ---- right: the live metrics, full curve drawn faint, live portion bold ---
ax_graph.plot(frame_t, area_safe, color="#f5b942", lw=0.8, alpha=0.35)
ax_graph.plot(frame_t, area_danger, color="#c8102e", lw=0.8, alpha=0.35)
line_safe, = ax_graph.plot([], [], color="#f5b942", lw=2.2, label="area > ρ_safe (2.5/m²)")
line_danger, = ax_graph.plot([], [], color="#c8102e", lw=2.2, label="area > ρ_D (4.0/m², danger)")
ax_g2 = ax_graph.twinx()
ax_g2.plot(frame_t, peak_so_far, color="#2c7fb8", lw=0.8, alpha=0.25)
line_peak, = ax_g2.plot([], [], color="#2c7fb8", lw=1.6, ls="--", label="peak density so far")
marker_t = ax_graph.axvline(0, color="#333", lw=1.2)
ax_graph.set_xlim(frame_t[0], frame_t[-1])
ax_graph.set_ylim(0, max(area_safe.max(), 1) * 1.1)
ax_g2.set_ylim(0, sim.RHO_MAX * 1.05)
if incident:
    ax_graph.axvline(incident["t"], color="#ff00ff", lw=1.4, ls=":")
    ax_graph.annotate(incident["label"], (incident["t"], ax_graph.get_ylim()[1]),
                      fontsize=7.5, color="#ff00ff", rotation=90, va="top", xytext=(3, -3), textcoords="offset points")
ax_graph.set_xlabel("time (s)", fontsize=9.5)
ax_graph.set_ylabel("floor area (m²)", fontsize=9.5)
ax_g2.set_ylabel("peak density so far (people/m²)", fontsize=9.5, color="#2c7fb8")
lines = [line_safe, line_danger, line_peak]
ax_graph.legend(lines, [l.get_label() for l in lines], fontsize=8, loc="upper right", frameon=False)
ax_graph.spines[["top"]].set_visible(False)
ax_graph.set_title("the numbers the picture is built from -- live", fontsize=10)

fig.suptitle(f"{sim.SCENARIOS[args.scenario]}\n{STEM} -- {args.u} layout", fontsize=11.5, weight="bold")


def update(i):
    field = np.where(vg.walkable, frames[i], np.nan)
    im.set_data(field)
    title_map.set_text(f"t={frame_t[i]:6.1f}s   peak {frames[i].max():.2f}/m²   "
                       f">safe {area_safe[i]:.0f}m²   >danger {area_danger[i]:.0f}m²")
    line_safe.set_data(frame_t[:i+1], area_safe[:i+1])
    line_danger.set_data(frame_t[:i+1], area_danger[:i+1])
    line_peak.set_data(frame_t[:i+1], peak_so_far[:i+1])
    marker_t.set_xdata([frame_t[i], frame_t[i]])
    return im, title_map, line_safe, line_danger, line_peak, marker_t


anim = FuncAnimation(fig, update, frames=n_frames, blit=False)
suffix = f"_{incident['label']}" if incident else ""
out = os.path.join(_HERE, f"animated_workflow_{args.scenario}{suffix}_{args.u}_{STEM}.gif")
anim.save(out, writer=PillowWriter(fps=args.fps))
print(f"wrote {out}")
