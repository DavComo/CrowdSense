"""explicit_density_workflow.py -- ONE static image, inspectable all at once
(not a GIF you have to watch play out): the mechanical workflow at the top,
the density map at many EXPLICIT, labeled timestamps in the middle, and the
actual numbers those pictures come from as a function of time at the bottom,
with each snapshot's moment marked on the graph.

    python3 explicit_density_workflow.py --venue path/to/your.crowdsense.json --scenario evacuation --panels 12
"""
import argparse
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

import arena, sim

_HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument("--venue", default=None)
ap.add_argument("--u", choices=["before", "after"], default="after",
                help="which layout in pipeline_result_<venue>.npz to run (default: after/optimized)")
ap.add_argument("--result", default=None)
ap.add_argument("--scenario", default="evacuation", choices=list(sim.SCENARIOS))
ap.add_argument("--panels", type=int, default=12)
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
    u = arena.default_u(venue, spec)   # no optimizer run yet -- use the drawn layout
    print(f"(no {result_path} -- showing the venue's own drawn layout, not an optimized one)")

_stops = [(0.0, "#ffffff"), (sim.RHO_SAFE / sim.RHO_MAX, "#f5b942"),
          (min(sim.RHO_D / sim.RHO_MAX, 0.99), "#c8102e"), (1.0, "#3a0008")]
CMAP = LinearSegmentedColormap.from_list("crowd", _stops)

# ---- run the real simulator, recording a frame every step for max fidelity
# on the graph, but only ~1s cadence would already be plenty for the panels
movable = arena.unpack(u, venue, spec)
geo = arena._effective_geo(venue, movable)
vg = sim.Venue(venue, movable, spec.room)
record_every = max(int(horizon / 300 / sim.DT), 1)   # ~300 samples for a smooth graph
print(f"running the real simulator: {args.scenario} on {STEM} ({args.u}), horizon {horizon:.0f}s ...")
r = sim.run(vg, args.scenario, horizon=horizon, record_every=record_every, record_frames=True)
frames, frame_t = r["frames"], np.array(r["frame_t"])
print(f"  {len(frames)} recorded frames, {int(horizon/sim.DT)} actual simulation steps")

# time series of the metrics the cost function is built from
area_over_safe = np.array([(f > sim.RHO_SAFE).sum() for f in frames]) * vg.dA
area_over_danger = np.array([(f > sim.RHO_D).sum() for f in frames]) * vg.dA
peak_so_far = np.maximum.accumulate([float(f.max()) for f in frames])

# ---- pick N panel times spread across the run ----
n_panels = min(args.panels, len(frames))
panel_idx = np.linspace(0, len(frames) - 1, n_panels).astype(int)
rx0, ry0, rx1, ry1 = spec.room
extent = [rx0, rx1, ry1, ry0]


def draw_venue(ax, field):
    ax.imshow(np.where(vg.walkable, field, np.nan), extent=extent, origin="upper",
              cmap=CMAP, vmin=0, vmax=sim.RHO_MAX, interpolation="nearest", zorder=1)
    for w in venue.get("walls", []):
        g = geo[w["id"]]
        if g["shape"] == "rect":
            ax.add_patch(patches.Rectangle((g["x"], g["y"]), g["w"], g["h"], fill=False,
                         edgecolor="#555", lw=1.0, zorder=3))
        elif g["shape"] == "line":
            xs = [p["x"] for p in g["points"]]; ys = [p["y"] for p in g["points"]]
            ax.plot(xs, ys, color="#555", lw=1.2, zorder=3)
    for z in venue.get("zones", []):
        g = geo[z["id"]]
        if g["shape"] == "rect":
            ax.add_patch(patches.Rectangle((g["x"], g["y"]), g["w"], g["h"], fill=False,
                         edgecolor="black", lw=0.8, ls="--", zorder=3))
    for p in venue.get("points", []):
        g = geo[p["id"]]
        c = "#5bb98c" if p.get("type") == "entrance" else "#e0564f"
        ax.scatter(g["x"], g["y"], s=45, color=c, edgecolor="black", zorder=5, marker="s")
    ax.set_xlim(rx0, rx1); ax.set_ylim(ry1, ry0); ax.set_aspect("equal"); ax.axis("off")


# ============================================================ figure layout
ncols = min(6, n_panels)
nrows_panels = -(-n_panels // ncols)
fig = plt.figure(figsize=(3.1 * ncols, 2.6 + 2.7 * nrows_panels + 3.3))
gs = fig.add_gridspec(3, 1, height_ratios=[1.0, 2.7 * nrows_panels, 2.4], hspace=0.35)

# ---- row 1: the literal workflow, as boxes + arrows -----------------------
ax_flow = fig.add_subplot(gs[0]); ax_flow.axis("off")
ax_flow.set_xlim(0, 1); ax_flow.set_ylim(0, 1)
steps = [
    "1. Load venue\n(fixed walls,\ndoors, zones)",
    "2. Place the\ncrowd (t=0)\nin its zones",
    f"3. Every {sim.ROUTE_EVERY*sim.DT:.0f}s:\nsolve routing\n(eikonal)",
    "4. Every 0.1s:\nmove density\n(finite-volume\nupwind flow)",
    "5. Apply doors:\nadmit / drain,\nclamp at ρ_max",
    f"6. Record a\nframe every\n{record_every*sim.DT:.1f}s (below)",
    "7. Score:\nHackathon.docx\ncost from ρ(x,t)",
]
n = len(steps)
box_w = 0.95 / n
for i, txt in enumerate(steps):
    xc = 0.03 + box_w * (i + 0.5)
    color = "#eef3fb" if i not in (3,) else "#fff3e0"   # highlight the hot loop
    box = FancyBboxPatch((xc - box_w * 0.44, 0.15), box_w * 0.88, 0.7,
                         boxstyle="round,pad=0.02,rounding_size=0.02",
                         facecolor=color, edgecolor="#333", lw=1.0, zorder=2)
    ax_flow.add_patch(box)
    ax_flow.text(xc, 0.5, txt, ha="center", va="center", fontsize=7.6, zorder=3)
    if i < n - 1:
        x0, x1 = xc + box_w * 0.44, xc + box_w * 0.56
        ax_flow.add_patch(FancyArrowPatch((x0, 0.5), (x1, 0.5), arrowstyle="-|>",
                          mutation_scale=10, color="#333", zorder=2))
loop_x0 = 0.03 + box_w * 2.06
loop_x1 = 0.03 + box_w * 5.5
ax_flow.annotate("", xy=(loop_x0, 0.05), xytext=(loop_x1, 0.05),
                 arrowprops=dict(arrowstyle="-|>", color="#a33", lw=1.3,
                                connectionstyle="arc3,rad=0.5"))
ax_flow.text((loop_x0 + loop_x1) / 2, -0.08, f"repeats {int(horizon/sim.DT)} times (every 0.1s of simulated time)",
            ha="center", fontsize=7.5, color="#a33")
ax_flow.set_title(f"WORKFLOW -- what run() actually does, step by step, on {STEM} ({args.scenario}, {args.u} layout)",
                  fontsize=10.5, weight="bold", pad=14)

# ---- row 2: the density map at N explicit timestamps ----------------------
gs_panels = gs[1].subgridspec(nrows_panels, ncols, wspace=0.08, hspace=0.45)
for k, fi in enumerate(panel_idx):
    ax = fig.add_subplot(gs_panels[k // ncols, k % ncols])
    draw_venue(ax, frames[fi])
    t = frame_t[fi]
    ax.set_title(f"#{k+1}  t={t:6.1f}s\npeak {frames[fi].max():.2f}/m²  "
                f">safe {area_over_safe[fi]:.0f}m²", fontsize=7.8)

# ---- row 3: the numbers those pictures come from, over time --------------
ax_g1 = fig.add_subplot(gs[2])
ax_g1.plot(frame_t, area_over_safe, color="#f5b942", lw=1.8, label="area > ρ_safe (2.5/m²)")
ax_g1.plot(frame_t, area_over_danger, color="#c8102e", lw=1.8, label="area > ρ_D (4.0/m², danger)")
ax_g2 = ax_g1.twinx()
ax_g2.plot(frame_t, peak_so_far, color="#2c7fb8", lw=1.3, ls="--", label="peak density so far")
ax_g2.set_ylabel("peak density reached so far (people/m²)", fontsize=8.5, color="#2c7fb8")
ax_g1.set_ylabel("floor area (m²)", fontsize=8.5)
ax_g1.set_xlabel("time (s)", fontsize=9)
for k, fi in enumerate(panel_idx):
    ax_g1.axvline(frame_t[fi], color="#999", lw=0.6, ls=":", zorder=0)
    ax_g1.annotate(f"{k+1}", (frame_t[fi], ax_g1.get_ylim()[1] * 0.96), fontsize=6.5,
                   ha="center", color="#555")
lines1, labels1 = ax_g1.get_legend_handles_labels()
lines2, labels2 = ax_g2.get_legend_handles_labels()
ax_g1.legend(lines1 + lines2, labels1 + labels2, fontsize=7.5, loc="upper right", frameon=False)
ax_g1.set_title("the density map's actual numbers, as a function of time -- panel markers (1-%d) show where each snapshot above sits" % n_panels,
               fontsize=9.5)
ax_g1.spines[["top"]].set_visible(False)

sm = plt.cm.ScalarMappable(cmap=CMAP, norm=plt.Normalize(0, sim.RHO_MAX))
cb = fig.colorbar(sm, ax=[fig.axes[i] for i in range(1, 1 + n_panels)], fraction=0.015, pad=0.01,
                  location="right", aspect=40)
cb.set_label("density (people/m²)", fontsize=8)

t = sim.appraise(r)
fig.suptitle(f"Explicit crowd-flow simulation -- {STEM}, {args.scenario}, {args.u} layout\n"
            f"final: cost {t['cost']:.3f}   peak {t['peak_rho']:.2f}/m²   "
            f"T95 {t['T95']:.0f}s{'​' if t['T95_reached'] else '+'}   "
            f"danger area {100*t['danger_frac']:.1f}%",
            fontsize=12, weight="bold")
out = os.path.join(_HERE, f"workflow_{args.scenario}_{args.u}_{STEM}.png")
plt.savefig(out, dpi=135, bbox_inches="tight")
print(f"wrote {out}")
