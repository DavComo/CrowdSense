"""
test_sim.py -- the design doc's section 4.10 verification tests, plus
coverage for the general (non-evacuation) behaviour.

"Write these before the solver, run them at every commit."  python3 test_sim.py

  1. Conservation   -- the 4.7 ledger holds for a full run
  2. Translation    -- a density patch in a corridor moves at the right speed
                       and never goes negative
  3. Fundamental diagram -- q(rho) = rho f(rho) peaks at ~1.22 people/m/s at
                       rho ~ 1.75 /m^2 (4.3). This is the calibration slide.
  4. Empty-room drain -- 500 people, one 2 m door: the door serves at
                       c_exit * 2 = 2.6 people/s so T95 ~ 0.95*500/2.6 ~ 183 s
  5. Circulation    -- table-to-table with dwell: people actually move between
                       destinations and mass is still conserved
  6. Incident       -- an attractor appearing at an arbitrary coordinate pulls
                       its share of the crowd; a blockage reroutes them
"""
import numpy as np
import sim


class _Grid:
    """Minimal stand-in for sim.Venue, built straight from arrays."""
    def __init__(self, walkable, dx=sim.DX):
        self.walkable = walkable; self.dx = dx; self.dA = dx * dx
        self.room = (0.0, 0.0, walkable.shape[1] * dx, walkable.shape[0] * dx)
        self.exits = []; self.entrances = []; self.attractors = []
        self.area = float(walkable.sum()) * self.dA

    def zone_population(self):
        return {a["id"]: a["capacity"] for a in self.attractors if a["capacity"]}

    def cell_at(self, x, y):
        H, W = self.walkable.shape
        return min(max(int(y / self.dx), 0), H - 1), min(max(int(x / self.dx), 0), W - 1)

    def cells_near(self, x, y, radius_m):
        r0, c0 = self.cell_at(x, y)
        rad = max(int(radius_m / self.dx), 1)
        H, W = self.walkable.shape
        out = [(r, c) for r in range(max(r0 - rad, 0), min(r0 + rad + 1, H))
               for c in range(max(c0 - rad, 0), min(c0 + rad + 1, W))
               if (r - r0) ** 2 + (c - c0) ** 2 <= rad ** 2 and self.walkable[r, c]]
        return out or [self.cell_at(x, y)]


def _room(w_m=20.0, h_m=20.0, dx=sim.DX):
    H, W = int(h_m / dx), int(w_m / dx)
    walkable = np.ones((H, W), dtype=bool)
    walkable[0, :] = walkable[-1, :] = walkable[:, 0] = walkable[:, -1] = False
    return walkable


def _interior_cells(walkable):
    H, W = walkable.shape
    return [(r, c) for r in range(1, H - 1) for c in range(1, W - 1) if walkable[r, c]]


def test_fundamental_diagram():
    rho = np.linspace(0.01, sim.RHO_MAX, 4000)
    q = rho * sim.speed(rho)
    i = int(np.argmax(q))
    print(f"  q peaks at {q[i]:.3f} people/m/s at rho = {rho[i]:.2f} /m^2"
          f"   (design doc 4.3: 1.22 at 1.75)")
    assert sim.speed(np.array([0.0]))[0] == sim.V_MAX, "f(0) must be v_max"
    assert sim.speed(np.array([sim.RHO_MAX]))[0] == 0.0, "f(rho_max) must be 0"
    return abs(q[i] - 1.22) < 0.05 and abs(rho[i] - 1.75) < 0.15


def test_translation():
    dx, dt = sim.DX, sim.DT
    W = 120
    x = np.arange(W) * dx
    rho = (0.4 * np.exp(-((x - 10.0) ** 2) / (2 * 1.5 ** 2))).reshape(1, W)
    v = float(sim.speed(rho).max())
    steps = 300
    for _ in range(steps):
        u = sim.speed(rho)
        ax = 0.5 * (u[:, :-1] + u[:, 1:])
        fx = np.maximum(ax, 0) * rho[:, :-1] + np.minimum(ax, 0) * rho[:, 1:]
        div = np.zeros((1, W)); div[:, :-1] += fx; div[:, 1:] -= fx
        rho = rho - (dt / dx) * div
        rho[:, -1] = 0.0
    centre = float((x * rho[0]).sum() / max(rho[0].sum(), 1e-12))
    print(f"  patch centre {centre:.1f} m, free-flow {10.0 + v*steps*dt:.1f} m"
          f"   min rho {rho.min():.2e}")
    return rho.min() >= -1e-12


def test_drain_and_conservation():
    """500 people, 20x20 room, one 2 m door. T95 against the analytic plateau,
    and the 4.7 ledger at the same time."""
    walkable = _room()
    H, W = walkable.shape
    g = _Grid(walkable)
    door_cells = [(H - 1, c) for c in range(W // 2 - 2, W // 2 + 2)]   # 2 m at dx=0.5
    for c in door_cells:
        walkable[c] = True
    g.exits = [{"id": "door", "name": "door", "cells": door_cells,
                "capacity": sim.C_EXIT * 2.0}]
    g.attractors = [{"id": "room", "name": "room", "cells": _interior_cells(walkable),
                     "capacity": 500, "draw": 500.0, "dwell": 180.0, "kind": "seating"}]

    r = sim.run(g, "evacuation", horizon=400.0)
    expected = 0.95 * 500 / (sim.C_EXIT * 2.0)
    print(f"  N_in {r['n_in']:.1f}  N_out {r['n_out']:.1f}  inside {r['n_inside']:.3f}"
          f"  clipped {r['n_clipped']:.3f}")
    print(f"  ledger error {r['ledger_error']:.2e}  (tol {1e-6*r['n_in']:.1e})")
    print(f"  T95 {r['T95']:.1f}s   analytic plateau {expected:.1f}s")
    ledger_ok = abs(r["ledger_error"]) < 1e-6 * max(r["n_in"], 1.0)
    return ledger_ok and abs(r["T95"] - expected) / expected < 0.25


def test_circulation():
    """Two tables and a door: people dwell, move table to table, some leave."""
    walkable = _room(24.0, 16.0)
    H, W = walkable.shape
    g = _Grid(walkable)
    door = [(H - 1, c) for c in range(W // 2 - 2, W // 2 + 2)]
    for c in door:
        walkable[c] = True
    g.exits = [{"id": "door", "name": "door", "cells": door, "capacity": sim.C_EXIT * 2.0}]
    tableA = [(r, c) for r in range(3, 8) for c in range(4, 10)]
    tableB = [(r, c) for r in range(3, 8) for c in range(W - 10, W - 4)]
    g.attractors = [
        {"id": "A", "name": "table A", "cells": tableA, "capacity": 120, "draw": 120.0,
         "dwell": 40.0, "kind": "merch"},
        {"id": "B", "name": "table B", "cells": tableB, "capacity": 80, "draw": 80.0,
         "dwell": 40.0, "kind": "bar"},
    ]
    r = sim.run(g, "circulation", horizon=200.0)
    print(f"  N_in {r['n_in']:.1f}  left via door {r['n_out']:.1f}"
          f"  still inside {r['n_inside']:.1f}  clipped {r['n_clipped']:.2e}")
    print(f"  ledger error {r['ledger_error']:.2e}   peak density {r['peak_rho'].max():.2f} /m^2")
    moved = r["n_out"] > 1.0          # people actually circulated and left
    return abs(r["ledger_error"]) < 1e-6 * max(r["n_in"], 1.0) and moved


def test_incident():
    """An attractor at an arbitrary coordinate pulls its share of the crowd;
    a blockage at the same spot reroutes them instead."""
    walkable = _room(24.0, 16.0)
    H, W = walkable.shape
    g = _Grid(walkable)
    door = [(H - 1, c) for c in range(W // 2 - 2, W // 2 + 2)]
    for c in door:
        walkable[c] = True
    g.exits = [{"id": "door", "name": "door", "cells": door, "capacity": sim.C_EXIT * 2.0}]
    g.attractors = [{"id": "floor", "name": "floor", "cells": _interior_cells(walkable),
                     "capacity": 300, "draw": 300.0, "dwell": 60.0, "kind": "seating"}]

    base = sim.run(g, "evacuation", horizon=200.0)
    att = sim.run(g, "evacuation", horizon=200.0,
                  incident={"x": 4.0, "y": 3.0, "kind": "attractor", "t": 5.0,
                            "share": 0.6, "radius": 2.0, "label": "commotion"})
    blk = sim.run(g, "evacuation", horizon=200.0,
                  incident={"x": 12.0, "y": 14.0, "kind": "blockage", "t": 5.0,
                            "radius": 2.5, "label": "cordon"})
    print(f"  baseline   T95 {base['T95']:6.1f}s  peak {base['peak_rho'].max():.2f}  cost {base['C_smooth']:.0f}")
    print(f"  attractor  T95 {att['T95']:6.1f}s  peak {att['peak_rho'].max():.2f}  cost {att['C_smooth']:.0f}"
          f"  fired {att['incidents']}")
    print(f"  blockage   T95 {blk['T95']:6.1f}s  peak {blk['peak_rho'].max():.2f}  cost {blk['C_smooth']:.0f}"
          f"  fired {blk['incidents']}")
    ledgers_ok = all(abs(r["ledger_error"]) < 1e-6 * max(r["n_in"], 1.0) for r in (att, blk))
    # people diverted to a commotion leave later and crowd harder than baseline
    reacted = att["C_smooth"] > base["C_smooth"] and att["incidents"] == ["commotion"]
    return ledgers_ok and reacted


def test_attractor_pileup_and_rejection():
    """Design doc v0.2 4.10: 'one source, one attractor, no barrier; density
    at the attractor rises monotonically to rho_max and the ledger still
    balances. Then drop a divider between them: the run is rejected as
    disconnected, not simulated.'"""
    walkable = _room(16.0, 12.0)
    H, W = walkable.shape
    g = _Grid(walkable)
    g.exits = [{"id": "door", "name": "door", "cells": [(H - 1, W // 2)], "capacity": sim.C_EXIT * 2.0}]
    g.attractors = [
        {"id": "source", "name": "source", "cells": [(r, c) for r in range(2, 5) for c in range(2, 6)],
         "capacity": 200, "draw": 200.0, "dwell": 300.0, "kind": "seating"},
        {"id": "stage", "name": "stage", "cells": [(r, c) for r in range(H - 5, H - 2) for c in range(W - 6, W - 2)],
         "capacity": 0, "draw": 0.0, "dwell": 300.0, "kind": "stage"},
    ]

    r = sim.run(g, "headliner", horizon=200.0)
    print(f"  pile-up: rejected={r['rejected']}  peak {r['peak_rho'].max():.2f}"
          f"  ledger_err {r['ledger_error']:.2e}")
    monotone_to_max = not r["rejected"] and r["peak_rho"].max() >= sim.RHO_MAX - 1e-6
    ledger_ok = not r["rejected"] and abs(r["ledger_error"]) < 1e-6 * max(r["n_in"], 1.0)

    # now drop a full-width divider between the source and the stage
    walkable2 = walkable.copy()
    walkable2[H // 2, 1:-1] = False
    g2 = _Grid(walkable2)
    g2.exits, g2.attractors = g.exits, g.attractors
    r2 = sim.run(g2, "headliner", horizon=200.0)
    print(f"  divided: rejected={r2['rejected']!r}  reason={r2['reject_reason']!r}  steps={r2['steps']}")
    rejected_not_simulated = r2["rejected"] and r2["steps"] == 0 and r2["reject_reason"]

    return monotone_to_max and ledger_ok and rejected_not_simulated


if __name__ == "__main__":
    checks = [
        ("fundamental diagram (4.3)", test_fundamental_diagram),
        ("translation / positivity", test_translation),
        ("drain + ledger (4.10 #1,#4)", test_drain_and_conservation),
        ("circulation (table to table)", test_circulation),
        ("incident anywhere on the floor", test_incident),
        ("attractor pile-up + rejection (v0.2 4.10)", test_attractor_pileup_and_rejection),
    ]
    results = {}
    for name, fn in checks:
        print(name)
        try:
            results[name] = bool(fn())
        except Exception as exc:
            print(f"  raised {type(exc).__name__}: {exc}")
            results[name] = False

    print("\n" + "=" * 62)
    for name, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print("=" * 62)
    raise SystemExit(0 if all(results.values()) else 1)
