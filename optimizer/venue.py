"""
venue.py -- a FIXED venue you cannot rebuild, and the levers you actually control.

The building is given. Walls, gates, gate widths: all fixed.
What a venue operator really controls is:
  1. which gates are STAFFED AND OPEN  (you never have enough staff for all of them)
  2. where the crowd is ROUTED         (signage, stanchions, barriers, ushers)

That is the optimisation problem. Everything below is a stand-in for the real
simulator -- swap `evaluate` for your teammates' version and nothing else changes.
"""

import numpy as np

WALK_SPEED = 1.3     # m/s
FLOW_RATE  = 1.3     # people/second per metre of gate width


class Venue:
    """A real building. You do not get to move any of this."""

    def __init__(self, gates, zones, staff_budget):
        self.gates  = np.array([g[:2] for g in gates], dtype=float)  # (K,2) positions
        self.widths = np.array([g[2]  for g in gates], dtype=float)  # (K,) metres
        self.zone_xy  = np.array([z[:2] for z in zones], dtype=float)  # (Z,2)
        self.zone_pop = np.array([z[2]  for z in zones], dtype=float)  # (Z,) people
        self.staff_budget = staff_budget
        self.K, self.Z = len(gates), len(zones)
        # walking distance from every zone to every gate, precomputed once
        self.dist = np.linalg.norm(
            self.zone_xy[:, None, :] - self.gates[None, :, :], axis=2)

    @property
    def n_people(self):
        return self.zone_pop.sum()


def evaluate(venue, open_mask, route):
    """Score one operating plan for this venue.

    open_mask : (K,) bool  -- which gates are staffed and open
    route     : (Z,) int   -- which gate each zone is sent to

    Returns evacuation time (seconds) and per-gate detail.
    """
    loads     = np.zeros(venue.K)
    walk_time = np.zeros(venue.K)

    for z in range(venue.Z):
        g = route[z]
        loads[g] += venue.zone_pop[z]
        walk_time[g] = max(walk_time[g], venue.dist[z, g] / WALK_SPEED)

    queue_time = np.zeros(venue.K)
    pressure   = np.zeros(venue.K)
    for g in range(venue.K):
        if not open_mask[g] or loads[g] == 0:
            continue
        queue_time[g] = loads[g] / (venue.widths[g] * FLOW_RATE)
        pressure[g]   = (loads[g] / venue.widths[g]) / 500.0

    gate_times = np.where(loads > 0, walk_time + queue_time, 0.0)
    return {
        "evac_time":     float(gate_times.max()),
        "peak_pressure": float(pressure.max()),
        "loads":         loads,
        "gate_times":    gate_times,
        "pressure":      pressure,
    }


def objective(venue, open_mask, route):
    """One number, lower is better. Evacuation time, penalised for crush risk."""
    r = evaluate(venue, open_mask, route)
    return r["evac_time"] + 300.0 * r["peak_pressure"]


def is_legal(venue, open_mask, route):
    """Every plan must respect staffing, and nobody is routed to a shut gate."""
    return open_mask.sum() <= venue.staff_budget and open_mask[route].all()


# ---------------------------------------------------------------------------
def demo_arena(seed=0):
    """A stand-in arena: 12 gates of uneven width, crowd unevenly distributed.

    Uneven on purpose. Real venues are lopsided -- that lopsidedness is
    exactly what there is to exploit.
    """
    rng = np.random.default_rng(seed)
    W = H = 60.0
    gates = [(10,0,2.5), (30,0,4.0), (50,0,2.5),        # south side, the main entrance
             (60,15,1.5), (60,45,1.5),                   # east, narrow service gates
             (50,60,3.0), (30,60,3.0), (10,60,3.0),      # north concourse
             (0,45,1.5), (0,15,1.5),                     # west, narrow
             (5,5,2.0),  (55,55,2.0)]                    # corner gates
    zones = []
    for i in range(6):
        for j in range(6):
            x, y = (i + .5) * W / 6, (j + .5) * H / 6
            crowding = 1.0 + 1.8 * np.exp(-((x - 20)**2 + (y - 20)**2) / 500)
            zones.append((x, y, float(rng.uniform(90, 130) * crowding)))
    return Venue(gates, zones, staff_budget=7)


def baseline_policy(venue):
    """What happens with NO intervention: open your widest gates, and everyone
    walks to whichever open gate is nearest. This is your 'before'."""
    open_mask = np.zeros(venue.K, dtype=bool)
    open_mask[np.argsort(-venue.widths)[:venue.staff_budget]] = True
    d = np.where(open_mask[None, :], venue.dist, np.inf)
    return open_mask, d.argmin(axis=1)
