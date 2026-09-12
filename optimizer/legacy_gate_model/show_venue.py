"""show_venue.py -- the before/after slide for a FIXED venue."""
import numpy as np, matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from venue import demo_arena, evaluate

v = demo_arena()
d = np.load("best_plan.npz")
plans = [("BEFORE   walk to your nearest gate", d["base_open"], d["base_route"]),
         ("AFTER   optimised routing plan",     d["open_mask"], d["route"])]

fig, axes = plt.subplots(1, 2, figsize=(12.5, 6))
cmap = plt.get_cmap("tab20")

for ax, (title, om, rt) in zip(axes, plans):
    r = evaluate(v, om, rt)
    peak = r["gate_times"].max()
    for z in range(v.Z):
        g = rt[z]
        ax.scatter(*v.zone_xy[z], s=v.zone_pop[z] * 0.55, color=cmap(g % 20),
                   alpha=.75, edgecolor="white", linewidth=.6, zorder=3)
        ax.plot([v.zone_xy[z,0], v.gates[g,0]], [v.zone_xy[z,1], v.gates[g,1]],
                color=cmap(g % 20), alpha=.28, lw=1.0, zorder=1)
    for g in range(v.K):
        openg = om[g]
        load  = r["loads"][g]
        hot   = r["gate_times"][g] > 0.92 * peak and load > 0
        ax.scatter(*v.gates[g], marker="s", zorder=6,
                   s=60 + v.widths[g] * 45,
                   color=(cmap(g % 20) if openg else "#dddddd"),
                   edgecolor=("red" if hot else "black"),
                   linewidth=(2.6 if hot else 1.0))
        if openg and load > 0:
            ax.annotate(f"{int(load)}", v.gates[g], fontsize=7.5, ha="center",
                        xytext=(0, 11), textcoords="offset points", zorder=7,
                        color=("red" if hot else "black"),
                        weight=("bold" if hot else "normal"))
    ax.add_patch(plt.Rectangle((0,0), 60, 60, fill=False, lw=1.8, zorder=2))
    ax.set_title(f"{title}\nevacuation {r['evac_time']:.0f} s     "
                 f"peak pressure {r['peak_pressure']:.2f}", fontsize=11)
    ax.set_xlim(-9, 69); ax.set_ylim(-9, 69); ax.set_aspect("equal"); ax.axis("off")

b, a = evaluate(v, *plans[0][1:]), evaluate(v, *plans[1][1:])
fig.suptitle("Same building. Same gates open. Same staff. Only the routing changed.\n"
             f"{100*(b['evac_time']-a['evac_time'])/b['evac_time']:.0f}% faster evacuation, "
             f"{100*(b['peak_pressure']-a['peak_pressure'])/b['peak_pressure']:.0f}% less crush pressure",
             fontsize=12.5, weight="bold")
plt.tight_layout(rect=[0,0,1,0.99])
plt.savefig("venue_before_after.png", dpi=140)
print("wrote venue_before_after.png   red outline = bottleneck gate")
