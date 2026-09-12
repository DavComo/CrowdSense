"""show_pipeline.py -- draw the actual club floor, before and after."""
import os
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from arena import load, score

_HERE = os.path.dirname(os.path.abspath(__file__))
_CANDIDATES = [
    os.path.join(_HERE, "..", "examples", "sample-venue.json"),
    os.path.join(_HERE, "sample-venue.json"),
]
VENUE_PATH = next((p for p in _CANDIDATES if os.path.exists(p)), _CANDIDATES[-1])
venue = load(VENUE_PATH)
d = np.load(os.path.join(_HERE, "pipeline_result.npz"))

def draw(ax, u, title):
    r = score(venue, u)
    cfg = r["cfg"]

    # fixed structure (grey, cannot move)
    stage = next(z for z in venue["zones"] if z["id"] == "zone_stage")
    ax.add_patch(patches.Rectangle((stage["x"],stage["y"]), stage["w"],stage["h"],
                 color="#999", label="stage (fixed)"))
    col = next(w for w in venue["walls"] if w["id"] == "wall_column_1")
    ax.add_patch(patches.Circle((col["cx"],col["cy"]), col["r"], color="#666"))
    ax.add_patch(patches.Rectangle((0,0), 30, 20, fill=False, lw=2, edgecolor="black"))

    # movable elements (colored, this is what the optimizer chose)
    px,py,pw,ph = cfg["pit"]
    ax.add_patch(patches.Rectangle((px,py),pw,ph, color="#8b7fe0", alpha=.6, label="GA floor (movable)"))
    bx,by,bw,bh = cfg["bar"]
    ax.add_patch(patches.Rectangle((bx,by),bw,bh, color="#4f8fd6", alpha=.8, label="bar (movable)"))
    rx,ry,rw,rh = cfg["riser"]
    ax.add_patch(patches.Rectangle((rx,ry),rw,rh, color="#c98f4f", alpha=.8, label="riser (movable)"))
    x1,y1,x2,y2 = cfg["divider"]
    ax.plot([x1,x2],[y1,y2], color="#333", lw=3, label="divider wall (movable)")

    for p in venue["points"]:
        c = "#5bb98c" if p["type"]=="entrance" else "#e0564f"
        ax.scatter(p["x"], p["y"], s=140, color=c, edgecolor="black", zorder=5, marker="s")
        ax.annotate(p["name"], (p["x"],p["y"]), fontsize=7, ha="center",
                    xytext=(0,8), textcoords="offset points")

    # pressure heatmap, translucent overlay
    H, W = r["pressure"].shape
    ax.imshow(np.clip(r["pressure"],0,3), extent=[0,30,20,0], origin="upper",
              cmap="Reds", alpha=.35, zorder=0, vmin=0, vmax=3)

    ax.set_title(f"{title}\nevac {r['evac_time']:.1f}s   peak pressure {r['peak_pressure']:.2f}",
                 fontsize=11)
    ax.set_xlim(-1,31); ax.set_ylim(21,-1); ax.set_aspect("equal"); ax.axis("off")

fig, axes = plt.subplots(1, 2, figsize=(13,6))
draw(axes[0], d["u0"], "BEFORE  (original JSON layout)")
draw(axes[1], d["u1"], "AFTER  (ML-optimised movable elements)")
axes[0].legend(loc="upper center", bbox_to_anchor=(0.5,-0.05), ncol=2, fontsize=7.5, frameon=False)
fig.suptitle("Same room, same stage, same fixed walls, same exits.\n"
             "Only the divider, riser, bar and pit were repositioned.",
             fontsize=12.5, weight="bold")
plt.tight_layout(rect=[0,0,1,0.95])
plt.savefig("club_before_after.png", dpi=140)
print("wrote club_before_after.png   red overlay = crowd pressure")
