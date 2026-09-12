"""show_pipeline.py -- the floor plan before and after, under every scenario.

Rows are scenarios (normal circulation, an evacuation, the headliner surge),
columns are the original layout vs the optimized one. The overlay is the
simulator's PEAK DENSITY over the run: dark red is above rho_safe (the cost
function's threshold), and the contour marks it. Fixed structure is grey,
movable elements are coloured -- they are the only thing that changed.

Generic: draws whatever is in the venue JSON, any shapes, any ids.
"""
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.colors import LinearSegmentedColormap

import arena, sim

_HERE = os.path.dirname(os.path.abspath(__file__))
_CANDIDATES = [
    os.path.join(_HERE, "..", "examples", "sample-venue.json"),
    os.path.join(_HERE, "sample-venue.json"),
]
VENUE_PATH = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[-1])
venue = arena.load(VENUE_PATH)
spec = arena.build_spec(venue)
d = np.load(os.path.join(_HERE, "pipeline_result.npz"))
MOVABLE_IDS = {e["id"] for e in spec.entries}

SHOW = [("circulation", 240.0, "normal operation (table to table)"),
        ("evacuation", 420.0, "evacuation"),
        ("headliner", 180.0, "headliner surge toward the stage")]

# white -> amber up to rho_safe, then red -> near-black above it
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


def draw(ax, u, scenario, horizon, title):
    movable = arena.unpack(u, venue, spec)
    geo = arena._effective_geo(venue, movable)
    vg = sim.Venue(venue, movable, spec.room)
    r = sim.run(vg, scenario, horizon=horizon)
    terms = sim.appraise(r)

    rx0, ry0, rx1, ry1 = spec.room
    H, W = r["peak_rho"].shape
    extent = [rx0, rx0 + W * vg.dx, ry0 + H * vg.dx, ry0]
    field = np.where(vg.walkable, r["peak_rho"], np.nan)
    ax.imshow(field, extent=extent, origin="upper", cmap=CMAP, vmin=0, vmax=sim.RHO_MAX,
              interpolation="nearest", zorder=0)
    ys = ry0 + (np.arange(H) + 0.5) * vg.dx; xs = rx0 + (np.arange(W) + 0.5) * vg.dx
    if np.nanmax(field) > sim.RHO_SAFE:
        ax.contour(xs, ys, np.nan_to_num(field), levels=[sim.RHO_SAFE], colors=["#7a0000"],
                   linewidths=0.9, zorder=1)

    seen = set()
    for w in venue.get("walls", []):
        mv = w["id"] in MOVABLE_IDS
        lab = "movable wall" if mv else "fixed wall"
        _draw_geo(ax, geo[w["id"]], "#c98f4f" if mv else "#555", 0.95, 1.2,
                  lab if lab not in seen else None); seen.add(lab)
    for z in venue.get("zones", []):
        mv = z["id"] in MOVABLE_IDS
        lab = f"{z.get('type', 'zone')} ({'movable' if mv else 'fixed'})"
        _draw_geo(ax, geo[z["id"]], z.get("color", "#8b7fe0"), 0.30 if mv else 0.75, 0.8,
                  lab if lab not in seen else None); seen.add(lab)
    for p in venue.get("points", []):
        g = geo[p["id"]]
        c = "#5bb98c" if p.get("type") == "entrance" else "#e0564f"
        ax.scatter(g["x"], g["y"], s=110, color=c, edgecolor="black", zorder=5, marker="s")
        ax.annotate(p.get("name", p["id"]), (g["x"], g["y"]), fontsize=6.5, ha="center",
                    xytext=(0, 7), textcoords="offset points", zorder=6)

    t95 = f"T95 {terms['T95']:.0f}s" + ("" if terms["T95_reached"] else "+")
    ax.set_title(f"{title}\ncost {terms['cost']:.3f}   peak {terms['peak_rho']:.1f}/m²   "
                 f"{t95}   >4/m² area {100*terms['danger_frac']:.1f}%", fontsize=8.5)
    ax.set_xlim(rx0, rx1); ax.set_ylim(ry1, ry0); ax.set_aspect("equal"); ax.axis("off")
    return terms


fig, axes = plt.subplots(len(SHOW), 2, figsize=(12.5, 4.2 * len(SHOW)))
summary = []
for i, (scen, horizon, label) in enumerate(SHOW):
    b = draw(axes[i, 0], d["u0"], scen, horizon, f"BEFORE — {label}")
    a = draw(axes[i, 1], d["u1"], scen, horizon, f"AFTER — {label}")
    summary.append((label, b["cost"], a["cost"]))

axes[0, 0].legend(loc="lower left", fontsize=6.5, frameon=True, framealpha=0.85, ncol=2)
sm = plt.cm.ScalarMappable(cmap=CMAP, norm=plt.Normalize(0, sim.RHO_MAX))
cb = fig.colorbar(sm, ax=axes.ravel().tolist(), fraction=0.02, pad=0.01)
cb.set_label("peak density over the run (people / m²)", fontsize=8)
cb.ax.axhline(sim.RHO_SAFE, color="#7a0000", lw=1.2)
cb.ax.text(1.4, sim.RHO_SAFE, f" ρ_safe = {sim.RHO_SAFE}", va="center", fontsize=7, color="#7a0000")

lines = "   ·   ".join(f"{lab}: {b:.2f} → {a:.2f}" for lab, b, a in summary)
fig.suptitle("Same building shell, same fixed walls, same doors. Only movable elements were repositioned.\n"
             f"Excess-density cost, before → after —  {lines}", fontsize=10.5, weight="bold")
out = os.path.join(_HERE, "club_before_after.png")
plt.savefig(out, dpi=140, bbox_inches="tight")
print(f"wrote {out}   overlay = peak density; contour = rho_safe; + = T95 not reached")
