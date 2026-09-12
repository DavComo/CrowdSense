"""
sim.py -- the crowd-flow simulator, per CrowdFlow_design_document.docx.

D1: corrected HUGHES CONTINUUM model, conservative finite-volume upwind on a
fixed grid. No agents, no Navier-Stokes momentum equation (an incompressible
solver cannot form a jam -- design doc Appendix A.1).

    ||grad phi_k|| = 1 / max(f(rho), eps_v)    phi_k = 0 on class k's targets
    e_k = -grad phi_k / ||grad phi_k||         u_k = f(rho_total) e_k
    d rho_k/dt + div(rho_k u_k) = s_in - s_out

Speed law is Weidmann/Kladek (D7): f(rho) = v_max [1 - exp(-gamma(1/rho - 1/rho_max))],
which reproduces the empirical fundamental diagram -- q = rho f peaks at
1.22 people/m/s at rho = 1.75 /m^2.

MULTI-CLASS, because a venue is not a single funnel. Density is carried as
rho[k] -- one class per DESTINATION -- so different parts of the crowd can be
walking to different places at the same time through shared congestion. That
is what makes the general cases expressible:

  * table-to-table (a fair): every zone is a destination. People walk to one,
    DWELL there (zones[].stickiness, the venue format's avg dwell minutes),
    then pick a new one from a transition matrix weighted by how big a draw
    each zone is. Some fraction leaves for an exit instead.
  * an incident anywhere: at t = t_incident, cells at an ARBITRARY location
    either become an attractor (a fight, a celebrity, a collapsed rig: a
    share of the crowd turns and converges on it) or a blockage (cordoned
    off: removed from walkable, density pushed to neighbours, everyone
    reroutes around it). Incidents are placed by coordinate, not by id, so
    you can stress-test a layout against an incident anywhere on the floor.
  * evacuation, ingress, a headliner surge: the same engine with different
    destinations and initial conditions.

Exits and entrances are just two kinds of destination. Nothing in the engine
privileges them.

COST (Hackathon.docx). Safety is scored by the excess-magnitude density
penalty, not by counting threshold crossings -- a cell at 5.0 people/m^2 is
not the same hazard as one at 3.6:

    C_severity = sum_t sum_ij max(0, rho - rho_safe)^p . dA . dt      (p = 2)
    C_smooth   = sum_t sum_ij (1/k) ln(1 + e^{k(rho - rho_safe)}) . dA . dt

C_smooth is the softplus relaxation -- differentiable, so gradient descent
through the surrogate never hits the kink in max(0, x). It is what the
optimizer trains against; C_severity is reported next to it.

All of this is exploratory modeling of movement and congestion under stated
assumptions. rho_max is a modeled standstill density, NOT a safe-occupancy
limit; the pressure proxy is a congestion-turbulence indicator, NOT a contact
load and NOT an injury prediction (design doc S7).
"""

import heapq
import numpy as np

import arena


# --- 4.8 parameters -------------------------------------------------------
V_MAX   = 1.34      # m/s      Weidmann free speed
GAMMA   = 1.913     # /m^2
RHO_MAX = 5.4       # /m^2     modeled standstill density (NOT a safe capacity)
EPS_V   = 0.05      # m/s      route-solve regularization only
DX      = 0.5       # m        D6
DT      = 0.1       # s        D6  (CFL 1.34*0.1/0.5 = 0.27 per axis)
HORIZON = 300.0     # s        D6
T_IN    = 120.0     # s        v0.2 4.8: ingress phase length within "ingress_egress"
ROUTE_EVERY = 10    # steps    D6
C_EXIT  = 1.3       # people/(m.s) per metre of door width
DOOR_WIDTH_DEFAULT = 2.0   # m, when an exit point carries no flowRate

RHO_D, T_D = 4.0, 30.0     # sustained-danger threshold / duration
P_STAR = 0.02              # /s^2, pressure-proxy indicator level
RHO_SAFE = 2.5             # /m^2, Fruin LoS D/E -- the cost threshold
COST_P = 2                 # excess-magnitude exponent
COST_K = 10.0              # softplus steepness
T_REF = 300.0              # s, T95 normalizer -- diagnostic only, not in cost

# The four numbers a scenario run is reported by. Canonical here (no torch
# dependency) so factory.py's workers and unet.py's SCALARS both read the
# same list without factory having to import unet (and drag torch into
# every worker process just to name four strings).
SCALARS = ("cost", "severity", "danger_frac", "max_P")

RHO_PACK = 0.85 * RHO_MAX  # /m^2, how tight initial placement packs a zone.
                           # Filling to rho_max pins cells at standstill, where
                           # f(rho) = 0 and every step sheds a sliver of mass to
                           # the clamp -- 50%+ of the crowd over a long run.
SUPPLY_PASSES = 24         # max Jacobi passes for the supply limiter (4.4)
TAU_ARRIVE = 2.0           # s, how fast arrivals at a destination settle into dwelling
DWELL_DEFAULT = 180.0      # s, if a zone has no stickiness
P_LEAVE = 0.25             # after dwelling, chance of heading for an exit


# --- 4.3 speed law --------------------------------------------------------
def speed(rho):
    """Weidmann/Kladek f(rho), clamped to [0, v_max]. f(0) = v_max."""
    inv_rho = np.where(rho > 1e-9, 1.0 / np.maximum(rho, 1e-9), 1e9)
    f = V_MAX * (1.0 - np.exp(-GAMMA * (inv_rho - 1.0 / RHO_MAX)))
    return np.clip(f, 0.0, V_MAX)


# --- 4.5 routing: eikonal solve by fast marching --------------------------
# scikit-fmm doesn't build on this Python, so this is a plain Godunov-upwind
# FMM. Pure-python lists in the inner loop (not numpy scalar indexing) --
# about 10x faster, and this is the hot path: it runs per class every 10 steps.

def eikonal(cost, walkable, target_cells, dx=DX):
    """Solve ||grad phi|| = cost with phi = 0 on target_cells, walls masked.
    `cost` is seconds per metre (1/speed). Returns phi, inf where no route."""
    H, W = walkable.shape
    INF = float("inf")
    phi = [INF] * (H * W)
    frozen = bytearray(H * W)
    walk = walkable.ravel().tolist()
    cst = cost.ravel().tolist()

    heap = []
    for (r, c) in target_cells:
        if 0 <= r < H and 0 <= c < W:
            k = r * W + c
            if walk[k] and phi[k] != 0.0:
                phi[k] = 0.0
                heapq.heappush(heap, (0.0, k))

    while heap:
        d, k = heapq.heappop(heap)
        if frozen[k]:
            continue
        frozen[k] = 1
        r, c = divmod(k, W)
        for nk in ((k - W if r > 0 else -1), (k + W if r < H - 1 else -1),
                   (k - 1 if c > 0 else -1), (k + 1 if c < W - 1 else -1)):
            if nk < 0 or frozen[nk] or not walk[nk]:
                continue
            nr, nc = divmod(nk, W)
            a = INF                                   # best frozen neighbour, rows
            if nr > 0 and frozen[nk - W] and phi[nk - W] < a:
                a = phi[nk - W]
            if nr < H - 1 and frozen[nk + W] and phi[nk + W] < a:
                a = phi[nk + W]
            b = INF                                   # best frozen neighbour, cols
            if nc > 0 and frozen[nk - 1] and phi[nk - 1] < b:
                b = phi[nk - 1]
            if nc < W - 1 and frozen[nk + 1] and phi[nk + 1] < b:
                b = phi[nk + 1]
            h = cst[nk] * dx
            if a == INF and b == INF:
                continue
            if a == INF or b == INF:
                t = (b if a == INF else a) + h
            elif abs(a - b) >= h:
                t = min(a, b) + h
            else:                                     # Godunov two-sided update
                t = 0.5 * (a + b + (2.0 * h * h - (a - b) ** 2) ** 0.5)
            if t < phi[nk]:
                phi[nk] = t
                heapq.heappush(heap, (t, nk))

    return np.array(phi, dtype=float).reshape(H, W)


def _shift(a, dr, dc, fill):
    out = np.full_like(a, fill)
    H, W = a.shape
    out[max(dr, 0):H + min(dr, 0), max(dc, 0):W + min(dc, 0)] = \
        a[max(-dr, 0):H + min(-dr, 0), max(-dc, 0):W + min(-dc, 0)]
    return out


def route_direction(phi, walkable, dx=DX):
    """e = -grad phi / ||grad phi||. A wall neighbour takes the centre value,
    so the difference degrades to one-sided there. Zero-gradient cells take
    the direction of their lowest-phi neighbour (design doc 4.5)."""
    big = 1e12
    p = np.where(np.isfinite(phi) & walkable, phi, big)
    up, down = _shift(p, 1, 0, big), _shift(p, -1, 0, big)
    left, right = _shift(p, 0, 1, big), _shift(p, 0, -1, big)
    up = np.where(up >= big, p, up);       down = np.where(down >= big, p, down)
    left = np.where(left >= big, p, left); right = np.where(right >= big, p, right)

    gx = (right - left) / (2 * dx)
    gy = (down - up) / (2 * dx)
    norm = np.hypot(gx, gy)
    ex = np.where(norm > 1e-12, -gx / np.maximum(norm, 1e-12), 0.0)
    ey = np.where(norm > 1e-12, -gy / np.maximum(norm, 1e-12), 0.0)

    flat = (norm <= 1e-12) & walkable & np.isfinite(phi)
    if flat.any():
        pick = np.argmin(np.stack([up, down, left, right]), axis=0)
        dirs = np.array([(0.0, -1.0), (0.0, 1.0), (-1.0, 0.0), (1.0, 0.0)])
        ex = np.where(flat, dirs[pick, 0], ex)
        ey = np.where(flat, dirs[pick, 1], ey)

    blocked = ~walkable | ~np.isfinite(phi)
    return np.where(blocked, 0.0, ex), np.where(blocked, 0.0, ey)


# --- crowd-pressure proxy (4.9) -------------------------------------------
def _window_stats(a, mask):
    H, W = a.shape
    acc = np.zeros((H, W)); acc2 = np.zeros((H, W)); cnt = np.zeros((H, W))
    m = mask.astype(float); am = a * m; am2 = am * a
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            acc += _shift(am, dr, dc, 0.0)
            acc2 += _shift(am2, dr, dc, 0.0)
            cnt += _shift(m, dr, dc, 0.0)
    cnt = np.maximum(cnt, 1.0)
    return acc / cnt, acc2 / cnt


def pressure_proxy(rho, ux, uy, walkable):
    """P = rho . Var_w(u), spatial variance of velocity over a 3x3 window
    (4.9). A congestion-turbulence proxy -- NOT a contact load."""
    mx, mx2 = _window_stats(ux, walkable)
    my, my2 = _window_stats(uy, walkable)
    var = np.maximum(mx2 - mx ** 2, 0.0) + np.maximum(my2 - my ** 2, 0.0)
    return np.where(walkable, rho * var, 0.0)


# --- the venue -> grid bridge ---------------------------------------------
class Venue:
    """Rasterized venue: walkable mask plus every place a crowd can be headed.
    Exits and entrances are just destinations with particular rules."""

    def _door_cells(self, obstacle, room, x, y, width_m, dx):
        """Carve a doorway of the given width and return its cells. A point
        left as a single cell is a 0.5 m door -- it fabricates a bottleneck at
        every entrance and exit, in every venue, no matter how it was drawn."""
        H, W = obstacle.shape
        r0, c0 = arena._to_cell(room, x, y, dx)
        r0 = min(max(r0, 0), H - 1); c0 = min(max(c0, 0), W - 1)
        half = max(int(round((width_m / dx) / 2)), 1)
        cells = []
        for r in range(max(r0 - half, 0), min(r0 + half + 1, H)):
            for c in range(max(c0 - half, 0), min(c0 + half + 1, W)):
                obstacle[r, c] = False
                cells.append((r, c))
        return cells or [(r0, c0)]

    def __init__(self, venue, movable, room, dx=DX):
        self.dx = dx
        self.room = room
        self.dA = dx * dx
        geo = arena._effective_geo(venue, movable)
        obstacle = arena._build_obstacle(venue, geo, room, cell=dx)

        self.exits, self.entrances = [], []
        for p in venue.get("points", []):
            g = geo[p["id"]]
            # rate is people per MINUTE (venue format's `throughput` field,
            # `flowRate` on older files -- arena._throughput reads either)
            rate_value = arena._throughput(p)
            # width implied by that rate at the empirical 1.3 people/(m.s),
            # else a standard double door
            implied = (rate_value / 60.0 / C_EXIT) if rate_value else DOOR_WIDTH_DEFAULT
            width = float(np.clip(implied, 1.0, 6.0))
            cells = self._door_cells(obstacle, room, g["x"], g["y"], width, dx)
            if p.get("type") in ("exit", "emergency-exit"):
                # null -> a default-width door at the empirical 1.3 people/(m.s).
                cap = (rate_value / 60.0) if rate_value else C_EXIT * DOOR_WIDTH_DEFAULT
                self.exits.append({"id": p["id"], "cells": cells, "capacity": cap,
                                    "name": p.get("name", p["id"])})
            elif p.get("type") == "entrance":
                rate = (rate_value or arena.DEFAULT_ENTRANCE_FLOW) / 60.0   # people/s
                self.entrances.append({"id": p["id"], "cells": cells, "rate": rate,
                                        "queue": 0.0, "name": p.get("name", p["id"])})

        self.walkable = ~obstacle

        # every zone a crowd might walk TO: a bar, a merch table, a pit, a
        # stage front. `draw` is how much of a pull it is, `dwell` how long
        # people stay once there.
        self.attractors = []
        for z in venue.get("zones", []):
            kind = arena._classify_zone(z)
            if kind == "populated":
                cells = arena._geo_interior_cells(obstacle, room, geo[z["id"]], cell=dx)
                # capacity/stickiness: honored from the venue file when
                # present (this project's own synthetic training venues,
                # from sample_venue.py, set them); otherwise derived from
                # the zone's own drawn area -- see arena._zone_capacity's
                # note on why the current editor schema doesn't carry an
                # explicit headcount.
                cap = arena._zone_capacity(z, geo[z["id"]])
                stick = arena._zone_stickiness(z)
                self.attractors.append({
                    "id": z["id"], "name": z.get("name", z["id"]), "cells": cells,
                    "capacity": cap,
                    "draw": float(cap or 1),
                    "dwell": (stick * 60.0) if stick else DWELL_DEFAULT,
                    "kind": z.get("type", "zone"),
                })
            elif z.get("type") == "stage":
                # nobody stands ON the stage; the crowd converges on its front
                self.attractors.append({
                    "id": z["id"], "name": z.get("name", z["id"]),
                    "cells": arena._geo_ring_cells(obstacle, room, geo[z["id"]], cell=dx),
                    "capacity": 0, "draw": 0.0, "dwell": DWELL_DEFAULT,
                    "kind": "stage",
                })

        self.area = float(self.walkable.sum()) * self.dA

    def cell_at(self, x, y):
        """Grid cell for a world coordinate -- how an incident gets placed
        anywhere on the floor, by coordinate rather than by element id."""
        H, W = self.walkable.shape
        r, c = arena._to_cell(self.room, x, y, self.dx)
        return min(max(r, 0), H - 1), min(max(c, 0), W - 1)

    def cells_near(self, x, y, radius_m):
        r0, c0 = self.cell_at(x, y)
        rad = max(int(radius_m / self.dx), 1)
        H, W = self.walkable.shape
        out = []
        for r in range(max(r0 - rad, 0), min(r0 + rad + 1, H)):
            for c in range(max(c0 - rad, 0), min(c0 + rad + 1, W)):
                if (r - r0) ** 2 + (c - c0) ** 2 <= rad ** 2 and self.walkable[r, c]:
                    out.append((r, c))
        return out or [self.cell_at(x, y)]

    def zone_population(self):
        """Who is standing where when the room starts full."""
        return {a["id"]: a["capacity"] for a in self.attractors if a["capacity"]}


# --- scenarios ------------------------------------------------------------
# A scenario is: what classes exist (one per destination), who starts where,
# who is still arriving, what happens when people get there, and what
# interrupts them. Everything else is the same engine.

def make_scenario(vg, name, incident=None, rng=None):
    """Build a scenario config for a rasterized venue. `incident` is
    {"x","y","kind","t","share","radius"} and may be placed anywhere."""
    rng = rng or np.random.default_rng(0)
    exits_cells = [c for e in vg.exits for c in e["cells"]]
    exit_cap = sum(e["capacity"] for e in vg.exits)
    zones = [a for a in vg.attractors if a["draw"] > 0]
    stages = [a for a in vg.attractors if a["kind"] == "stage"]

    def exit_class():
        return {"id": "__exits__", "name": "exits", "cells": exits_cells,
                "absorbing": True, "capacity": exit_cap, "dwell": 0.0}

    def zone_class(a):
        return {"id": a["id"], "name": a["name"], "cells": a["cells"],
                "absorbing": False, "capacity": 0.0, "dwell": a["dwell"]}

    classes, initial, inflow, transitions = [], {}, {}, None
    pop = vg.zone_population()
    total_pop = sum(pop.values()) or 0.0

    if name == "evacuation":
        classes = [exit_class()]
        initial = {"__exits__": pop}          # everyone, wherever they stand, heads out
        inflow = {}

    elif name == "ingress":
        classes = [zone_class(a) for a in zones]
        initial = {}
        draws = np.array([a["draw"] for a in zones], dtype=float)
        draws = draws / draws.sum() if draws.sum() else np.ones(len(zones)) / max(len(zones), 1)
        inflow = {e["id"]: {c["id"]: float(w) for c, w in zip(classes, draws)} for e in vg.entrances}

    elif name == "ingress_egress":
        # v0.2 4.0: one continuous run, two phases. Ingress (0..T_IN): doors
        # open, empty room fills toward the attracting cells (stage/bar/pit)
        # -- this is the front-of-stage crush. At T_IN, sources shut off and
        # everyone still inside reroutes to the nearest exit -- the door
        # bottleneck. `run()` does the actual phase switch at cfg
        # ["phase_switch_t"]; this just sets up phase 1, identically to
        # "ingress" above.
        classes = [zone_class(a) for a in zones]
        initial = {}   # room starts EMPTY -- ingress fills it, not a preset population
        draws = np.array([a["draw"] for a in zones], dtype=float)
        draws = draws / draws.sum() if draws.sum() else np.ones(len(zones)) / max(len(zones), 1)
        inflow = {e["id"]: {c["id"]: float(w) for c, w in zip(classes, draws)} for e in vg.entrances}

    elif name == "headliner":
        target = stages or zones[:1]
        classes = [{"id": target[0]["id"], "name": target[0]["name"], "cells": target[0]["cells"],
                    "absorbing": False, "capacity": 0.0, "dwell": DWELL_DEFAULT}] if target else []
        initial = {classes[0]["id"]: pop} if classes else {}
        inflow = {}

    elif name == "circulation":
        # the fair: every zone is a table, people move table to table, some
        # leave. This is the venue's NORMAL operation, and it is where most
        # of the hours in a real venue actually are.
        classes = [zone_class(a) for a in zones] + ([exit_class()] if exits_cells else [])
        initial = {}
        for a in zones:                       # start people dwelling where they are
            if pop.get(a["id"]):
                initial.setdefault(a["id"], {})[a["id"]] = pop[a["id"]]
        draws = np.array([a["draw"] for a in zones], dtype=float)
        draws = draws / draws.sum() if draws.sum() else np.ones(len(zones)) / max(len(zones), 1)
        inflow = {e["id"]: {a["id"]: float(w) for a, w in zip(zones, draws)} for e in vg.entrances}
        # after dwelling at i: pick the next destination in proportion to
        # draw -- INCLUDING staying where you are for another spell -- or
        # leave. Excluding "stay" made the two-zone case degenerate: with a
        # 500-person floor and a 20-person bar, every single person on the
        # floor was sent to the bar, 375 of them at once.
        ids = [c["id"] for c in classes]
        transitions = {}
        wsum = float(draws.sum()) if len(draws) else 0.0
        for a in zones:
            row = {}
            stay = 1.0 if not exits_cells else (1 - P_LEAVE)
            for b, w in zip(zones, draws):
                p_b = (w / wsum) if wsum else 1.0 / max(len(zones), 1)
                if b["id"] != a["id"]:
                    row[b["id"]] = stay * p_b
                else:
                    row[b["id"]] = stay * p_b      # "stay" re-enters the same class
            if exits_cells:
                row["__exits__"] = P_LEAVE
            transitions[a["id"]] = row
        for i in ids:
            transitions.setdefault(i, {})

    else:
        raise ValueError(f"unknown scenario {name!r}")

    venue_capacity = sum(a["capacity"] for a in vg.attractors)
    cfg = {"name": name, "classes": classes, "initial": initial, "inflow": inflow,
           "transitions": transitions, "incidents": [], "total_pop": total_pop,
           "venue_capacity": venue_capacity}
    if name == "ingress_egress":
        cfg["phase_switch_t"] = T_IN
        cfg["egress_cells"] = exits_cells
        cfg["egress_capacity"] = exit_cap

    if incident:
        cfg["incidents"].append({
            "t": incident.get("t", 60.0),
            "kind": incident.get("kind", "attractor"),
            "cells": vg.cells_near(incident["x"], incident["y"], incident.get("radius", 3.0)),
            "share": incident.get("share", 0.5),
            "label": incident.get("label", incident.get("kind", "incident")),
        })
    return cfg


SCENARIOS = {
    "evacuation":     "alarm sounds, full room, everyone leaves by the nearest exit",
    "ingress":        "doors open, people stream in toward whatever they came for",
    "headliner":      "the act starts, the whole room surges toward the stage front",
    "circulation":    "normal operation: table to table, dwell, move on, some leave",
    "ingress_egress": "v0.2's own demo shape: one run, two phases -- fill for "
                       "T_IN then drain -- reporting the stage-front crush and "
                       "the door bottleneck as separate peaks from one simulation",
}

# per-scenario weight in the blended appraisal. Normal operation is most of a
# venue's hours; the surge and the evacuation are where the risk is.
SCENARIO_WEIGHTS = {"evacuation": 1.0, "ingress": 0.6, "headliner": 1.0, "circulation": 0.8,
                    "ingress_egress": 1.0}


def _spread(field, occupied, walkable, cells, people, dA):
    """Put `people` on `cells`, filling each to at most rho_max and expanding
    to neighbouring walkable cells when the footprint is too small. Returns
    however many people could not be placed anywhere (venue is full)."""
    H, W = walkable.shape
    frontier = [c for c in cells if walkable[c]]
    seen = set(frontier)
    remaining = people
    while remaining > 1e-9 and frontier:
        room = [(c, RHO_PACK - occupied[c]) for c in frontier if RHO_PACK - occupied[c] > 1e-12]
        if room:
            capacity = sum(r for _, r in room) * dA
            take = min(capacity, remaining)
            frac = take / capacity
            for c, r in room:
                add = r * frac
                field[c] += add
                occupied[c] += add
            remaining -= take
        nxt = []
        for (r0, c0) in frontier:
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (r0 + dr, c0 + dc)
                if 0 <= n[0] < H and 0 <= n[1] < W and walkable[n] and n not in seen:
                    seen.add(n); nxt.append(n)
        frontier = nxt
    return remaining


def check_feasible(vg, cfg):
    """v0.2 4.0's consistency rule, run BEFORE spending 3000 timesteps on a
    layout that can never work: does every class that actually has people
    (initial population or entrance inflow) have a route to its own target
    at all? Free-flow cost (rho=0) is the right cost to check with --
    congestion only ever makes a route slower or backed-up, never opens one
    that free-flow doesn't already have, so free-flow reachability is a
    valid necessary condition. Returns (ok: bool, reason: str); on failure
    the caller must reject the layout, not simulate it (design doc: "a
    layout that fails is rejected with the reason, never simulated")."""
    walkable = vg.walkable
    if not walkable.any():
        return False, "no walkable area at all"
    # cfg["initial"] is {class_id: {zone_id: people}} -- the OUTER key is
    # the class (who's routing where), the INNER key is which zone's
    # footprint they're physically STANDING ON at t=0 (that's the actual
    # source location to check reachability from -- checking "is the
    # target reachable from ANYWHERE in the room" is not the same claim
    # and missed a fully-disconnected source on the first pass: 300 of 630
    # cells were reachable, just not the one the population starts on).
    src_cells = {c["id"]: [] for c in cfg["classes"]}
    for cid, where in cfg["initial"].items():
        if cid not in src_cells:
            continue
        for zone_id, people in where.items():
            if people <= 0:
                continue
            att = next((a for a in vg.attractors if a["id"] == zone_id), None)
            if att:
                src_cells[cid] += [c for c in att["cells"] if walkable[c]]
    for weights in cfg["inflow"].values():
        for cid, w in weights.items():
            if w > 0 and cid in src_cells:
                pass   # entrance cells checked separately below (shared by all inflow classes)
    entrance_cells = [c for e in vg.entrances for c in e["cells"] if walkable[c]]
    has_inflow = {cid for weights in cfg["inflow"].values() for cid, w in weights.items() if w > 0}

    free_cost = np.full(walkable.shape, 1.0 / V_MAX)
    for c in cfg["classes"]:
        origins = list(src_cells.get(c["id"], []))
        if c["id"] in has_inflow:
            origins += entrance_cells
        if not origins:
            continue   # this class has no population from any source -- nothing to check
        tgt = [cell for cell in c["cells"] if walkable[cell]]
        if not tgt:
            return False, f"class {c['id']!r} has population but no reachable target cell"
        phi = eikonal(free_cost, walkable, tgt, vg.dx)
        reachable = np.isfinite(phi[tuple(np.array(origins).T)])
        # a real failure mode, not a hypothetical: an oversized `extendable`
        # zone straddling a movable wall's new position can have MOST of its
        # footprint on the exit side and a real pocket of it walled off on
        # the other -- `.any()` (at least one origin cell escapes) missed
        # this entirely and let the search ship a layout that stranded 8.6%
        # of its population, caught only after a full 3000-step re-sim.
        # >=99% matches this project's own 1% clipped-mass tolerance.
        if reachable.mean() < 0.99:
            return False, (f"class {c['id']!r}: only {100*reachable.mean():.0f}% of its "
                           f"source cells can reach its target")
    if cfg["name"] in ("evacuation", "ingress_egress") and not vg.exits:
        return False, "no exit exists for a scenario that requires one"
    return True, ""


# --- 4.4/4.6 the time stepper ---------------------------------------------
def run(vg, scenario="evacuation", incident=None, horizon=HORIZON, dt=DT,
        route_every=ROUTE_EVERY, rho_safe=RHO_SAFE, record_every=10, rng=None,
        record_frames=False):
    """One scenario on one layout. Multi-class: rho[k] is the part of the
    crowd headed for destination k. Returns metrics, cost and maps.
    record_frames=True additionally returns "frames"/"frame_t": a movie of
    rho_tot every `record_every` steps, for visualization -- off by default
    since it costs memory nobody wants during factory generation."""
    cfg = make_scenario(vg, scenario, incident=incident, rng=rng) if isinstance(scenario, str) else scenario
    walkable = vg.walkable.copy()
    dx, dA = vg.dx, vg.dA
    H, W = walkable.shape
    classes = list(cfg["classes"])

    empty = {"scenario": cfg["name"], "disconnected": True, "T95": horizon, "T95_reached": False,
             "A_danger": vg.area, "max_P": 10.0, "C_severity": 1e6, "C_smooth": 1e6,
             "peak_rho": np.zeros((H, W)), "rho_final": np.zeros((H, W)),
             "ingress_peak_rho": None, "egress_peak_rho": None, "phase_switch_t": None,
             "n_in": 0.0, "n_out": 0.0, "n_inside": 0.0, "n_clipped": 0.0,
             "ledger_error": 0.0, "steps": 0, "area": vg.area, "incidents": [],
             "n_unplaced": 0.0, "rejected": False, "reject_reason": "", "frames": [], "frame_t": []}
    if not classes or not walkable.any():
        return empty

    ok, reason = check_feasible(vg, cfg)
    if not ok:
        # v0.2 4.0: "a layout that fails is rejected with the reason, never
        # simulated" -- return immediately, don't burn 3000 timesteps on a
        # layout that was never going to work. `disconnected=True` keeps
        # this failing `sim.is_valid()` the same way a mid-run disconnect
        # already does; `rejected`/`reject_reason` say WHY without having
        # to infer it from a zero-population, zero-cost, all-empty result.
        return {**empty, "rejected": True, "reject_reason": reason}

    K = len(classes)
    idx = {c["id"]: k for k, c in enumerate(classes)}
    rho = np.zeros((K, H, W))       # walking, by destination
    dwell = np.zeros((K, H, W))     # arrived and lingering (not transported)

    # ---- initial population ----
    # A zone's capacity rarely fits on its own footprint at a walkable
    # density -- 120 people "at the merch table" stand AROUND it. Fill to
    # rho_max and spread the rest outward, rather than stacking everyone on
    # the zone and letting the clamp delete them.
    occupied = np.zeros((H, W))
    unplaced = 0.0
    for class_id, where in cfg["initial"].items():
        k = idx[class_id]
        for zone_id, people in where.items():
            att = next((a for a in vg.attractors if a["id"] == zone_id), None)
            if not att or not people:
                continue
            field = dwell[k] if cfg["name"] == "circulation" else rho[k]
            unplaced += _spread(field, occupied, walkable, att["cells"], float(people), dA)

    n_in = float((rho.sum(0) + dwell.sum(0)).sum() * dA)
    n_out = 0.0
    n_clipped = 0.0
    n_unplaced = unplaced          # never fit in the door -- reported, not hidden
    t95 = None
    peak_rho = rho.sum(0).copy()
    danger_run = np.zeros((H, W)); danger_ever = np.zeros((H, W), dtype=bool)
    max_p = 0.0
    c_sev = c_smooth = 0.0
    disconnected = False
    fired = []
    entr_queue = {e["id"]: 0.0 for e in vg.entrances}
    phi = [None] * K; ex = [None] * K; ey = [None] * K
    need_route = True

    # v0.2 4.0: "a run has an ingress phase ... and an egress phase ...".
    # Only "ingress_egress" uses this; every other scenario keeps phase=None
    # and the block below never fires.
    phase = "ingress" if cfg.get("phase_switch_t") is not None else None
    ingress_peak_rho = None
    egress_peak_rho = None
    phase_switch_t = None
    frames, frame_t = [], []

    steps = int(horizon / dt)
    for step in range(steps):
        t = step * dt
        rho_tot = rho.sum(0)

        # ---- incidents: anywhere on the floor, at any time ----
        for inc in cfg["incidents"]:
            if inc in fired or t < inc["t"]:
                continue
            fired.append(inc)
            cells = [c for c in inc["cells"] if walkable[c]]
            if inc["kind"] == "blockage":
                # cordoned off: remove from walkable, push density to the
                # nearest walkable neighbours, and log it (4.6).
                for c in cells:
                    walkable[c] = False
                    moved = rho[:, c[0], c[1]].copy(); dmoved = dwell[:, c[0], c[1]].copy()
                    rho[:, c[0], c[1]] = 0.0; dwell[:, c[0], c[1]] = 0.0
                    nbrs = [(c[0] + dr, c[1] + dc) for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1))
                            if 0 <= c[0] + dr < H and 0 <= c[1] + dc < W and walkable[c[0] + dr, c[1] + dc]]
                    if nbrs:
                        for nb in nbrs:
                            rho[:, nb[0], nb[1]] += moved / len(nbrs)
                            dwell[:, nb[0], nb[1]] += dmoved / len(nbrs)
                    else:
                        n_clipped += float((moved.sum() + dmoved.sum()) * dA)
            else:
                # an attractor appears: a share of everyone turns toward it
                classes.append({"id": f"__incident_{len(classes)}__", "name": inc["label"],
                                "cells": cells, "absorbing": False, "capacity": 0.0,
                                "dwell": DWELL_DEFAULT})
                K = len(classes)
                idx = {c["id"]: k for k, c in enumerate(classes)}
                rho = np.concatenate([rho, np.zeros((1, H, W))], axis=0)
                dwell = np.concatenate([dwell, np.zeros((1, H, W))], axis=0)
                phi.append(None); ex.append(None); ey.append(None)
                s = float(np.clip(inc["share"], 0.0, 1.0))
                rho[-1] += rho[:-1].sum(0) * s
                rho[:-1] *= (1 - s)
                dwell[-1] += dwell[:-1].sum(0) * s      # people get up and go look
                dwell[:-1] *= (1 - s)
            need_route = True

        # ---- v0.2 4.0: ingress -> egress phase switch at T_IN ----
        if phase == "ingress" and t >= cfg["phase_switch_t"]:
            ingress_peak_rho = peak_rho.copy()
            egress_peak_rho = np.zeros((H, W))
            phase_switch_t = t
            # Merge everyone into ONE shared, absorbing "heading for the
            # exit" class. Just re-pointing each existing class's `cells` at
            # the exit would leave several classes independently draining
            # through the same physical door, each computing its own
            # capacity-limited departure against the FULL door capacity --
            # double (or K-times) counting it. One merged class draining
            # through `c["capacity"]` is the same sharing rule "circulation"
            # already uses for its single `__exits__` class.
            merged = rho.sum(0) + dwell.sum(0)
            rho[:] = 0.0; dwell[:] = 0.0
            rho[0] = merged
            classes[0] = {"id": "__egress__", "name": "egress",
                          "cells": cfg["egress_cells"], "absorbing": True,
                          "capacity": cfg["egress_capacity"], "dwell": 0.0}
            for k in range(1, K):
                classes[k] = {"id": f"__spent_{k}__", "name": "spent", "cells": [],
                              "absorbing": False, "capacity": 0.0, "dwell": 0.0}
            idx = {c["id"]: k for k, c in enumerate(classes)}
            cfg["inflow"] = {}   # doors close -- ingress is over
            phase = "egress"
            need_route = True

        # ---- 4.5 routing, one eikonal per class ----
        if step % route_every == 0 or need_route:
            f_route = np.maximum(speed(rho_tot), EPS_V)
            cost = 1.0 / f_route
            for k, c in enumerate(classes):
                tgt = [cell for cell in c["cells"] if walkable[cell]]
                phi[k] = eikonal(cost, walkable, tgt, dx) if tgt else np.full((H, W), np.inf)
                ex[k], ey[k] = route_direction(phi[k], walkable, dx)
                # "disconnected" means someone is actually stuck, not "some
                # unoccupied pocket of floor happens to be unreachable from
                # this target" -- rearranging movable furniture routinely
                # carves off small dead corners nobody stands in, and
                # flagging THAT as a safety failure made the search's own
                # candidates fail validity almost every time (traced by
                # regenerating a rejected U-Net candidate and finding it
                # wasn't actually clipping mass -- disconnected was tripping
                # on empty floor space instead). Only cells this class
                # actually occupies matter.
                occupied = (rho[k] > 1e-6) | (dwell[k] > 1e-6)
                if tgt and occupied.any() and not np.isfinite(phi[k][occupied]).all():
                    disconnected = True
            need_route = False

        f = speed(rho_tot)

        # ---- 4.4 conservative upwind transport, per class ----
        coef = dt / dx
        fx = np.zeros((K, H, W - 1)); fy = np.zeros((K, H - 1, W))
        openx = walkable[:, :-1] & walkable[:, 1:]
        openy = walkable[:-1, :] & walkable[1:, :]
        for k in range(K):
            ux, uy = f * ex[k], f * ey[k]
            ax = 0.5 * (ux[:, :-1] + ux[:, 1:])
            fx[k] = np.where(openx, np.maximum(ax, 0) * rho[k][:, :-1] + np.minimum(ax, 0) * rho[k][:, 1:], 0.0)
            ay = 0.5 * (uy[:-1, :] + uy[1:, :])
            fy[k] = np.where(openy, np.maximum(ay, 0) * rho[k][:-1, :] + np.minimum(ay, 0) * rho[k][1:, :], 0.0)

        # SUPPLY LIMITING. Plain upwind keeps pushing people into a cell that
        # is already jammed -- the receiving cell's speed is not what throttles
        # the face flux -- so rho runs past rho_max and the clamp deletes
        # people (34% of the crowd on the 4.10 drain test before this). Scale
        # every face by how much room its RECEIVING cell has, across ALL
        # classes at once, since congestion is shared. Same rule 4.6 already
        # applies at entrances. Mass is conserved; it waits upstream instead,
        # which is what a queue is.
        # Scaling one face changes its neighbours' outflow, so this is a
        # Jacobi iteration -- it has to run to convergence, not a fixed 2
        # passes (at 2 passes, half the crowd was still being clipped in a
        # congested circulation run). Uncongested steps exit on the first
        # pass, so the cost lands only where there is an actual jam.
        for _ in range(SUPPLY_PASSES):
            inflow = np.zeros((H, W)); outflow = np.zeros((H, W))
            px, nx = np.maximum(fx, 0.0).sum(0), np.maximum(-fx, 0.0).sum(0)
            outflow[:, :-1] += px; inflow[:, 1:] += px
            outflow[:, 1:] += nx;  inflow[:, :-1] += nx
            py, ny = np.maximum(fy, 0.0).sum(0), np.maximum(-fy, 0.0).sum(0)
            outflow[:-1, :] += py; inflow[1:, :] += py
            outflow[1:, :] += ny;  inflow[:-1, :] += ny
            room = np.maximum(RHO_MAX - rho_tot - dwell.sum(0), 0.0) * (1 - 1e-9) / coef + outflow
            over = inflow > room
            if not over.any():
                break
            lam = np.clip(np.where(over, room / np.maximum(inflow, 1e-12), 1.0), 0.0, 1.0)
            fx = np.where(fx > 0, fx * lam[None, :, 1:], fx * lam[None, :, :-1])
            fy = np.where(fy > 0, fy * lam[None, 1:, :], fy * lam[None, :-1, :])

        div = np.zeros((K, H, W))
        div[:, :, :-1] += fx; div[:, :, 1:] -= fx
        div[:, :-1, :] += fy; div[:, 1:, :] -= fy
        rho = rho - coef * div

        # ---- arrivals: absorbing destinations drain, the rest hold people ----
        for k, c in enumerate(classes):
            cells = [cell for cell in c["cells"] if walkable[cell]]
            if not cells:
                continue
            rows = np.array([cell[0] for cell in cells]); cols = np.array([cell[1] for cell in cells])
            here = rho[k][rows, cols]
            if here.sum() <= 0:
                continue
            if c["absorbing"]:
                # a doorway serves at its capacity while anyone is queued at
                # it -- that capacity, not the jammed cell's own rho.f(rho),
                # is the limiter the eikonal solve doesn't provide (4.6).
                available = float((here * dA).sum())
                leave = min(c["capacity"] * dt, available)
                if leave > 0:
                    share = here / here.sum()
                    rho[k][rows, cols] = np.maximum(here - leave * share / dA, 0.0)
                    n_out += leave
            else:
                settle = here * min(dt / TAU_ARRIVE, 1.0)
                rho[k][rows, cols] = here - settle
                dwell[k][rows, cols] += settle

        # ---- dwelling: linger, then pick somewhere new to go (the fair) ----
        if cfg["transitions"]:
            for k, c in enumerate(classes):
                if c["absorbing"] or c["dwell"] <= 0:
                    continue
                row = cfg["transitions"].get(c["id"])
                if not row:
                    continue
                release = dwell[k] * (dt / c["dwell"])
                if release.sum() <= 0:
                    continue
                dwell[k] -= release
                for dest_id, p in row.items():
                    if p > 0 and dest_id in idx:
                        rho[idx[dest_id]] += release * p
                # NOTE: the "stay" share of `row` routes back through `rho`
                # (a lap through your own footprint) rather than staying in
                # `dwell` directly -- conceptually odd, but harmless in
                # practice: it's a pure relabel at the SAME cells (net
                # rho+dwell there is unchanged), and holding it in `dwell`
                # directly was tried and measured WORSE (skips the gradual
                # TAU_ARRIVE re-settling below, which was smoothing this out).
                # The real source of clipped mass here turned out to be the
                # entrance-admission allocation below, not this -- traced by
                # instrumenting every phase of run() on a failing case.

        # ---- 4.6 entrances: rate-limited admission, unadmitted demand queues
        n_inside_now = float((rho.sum(0) + dwell.sum(0)).sum() * dA)
        venue_room = max(cfg["venue_capacity"] - n_inside_now, 0.0) if cfg["venue_capacity"] else 1e18
        for ent in vg.entrances:
            weights = cfg["inflow"].get(ent["id"])
            if not weights:
                continue
            cells = [c for c in ent["cells"] if walkable[c]]
            if not cells:
                continue
            want = ent["rate"] * dt + entr_queue[ent["id"]]
            occupied = rho.sum(0) + dwell.sum(0)
            room_per_cell = {c: max(RHO_MAX - occupied[c], 0.0) for c in cells}
            total_room = sum(room_per_cell.values())
            door_room = total_room * dA
            # a doorman, not just "is the doormat itself full": stop admitting
            # once the venue has reached the crowd size it was drawn for, so
            # a long circulation window can't silently double-book the room.
            admit = min(ent["rate"] * dt, door_room, want, venue_room)
            venue_room -= admit
            entr_queue[ent["id"]] = want - admit
            if admit > 0:
                # FIX: `admit <= door_room` bounds the AGGREGATE across the
                # door's cells, but a real door isn't one cell -- if one cell
                # is already crowded and another isn't, splitting `admit`
                # EVENLY still overflows the crowded one even though the sum
                # is fine. This was the actual source of the circulation
                # scenario's clipped mass (traced by instrumenting every
                # phase of run() -- it only ever appeared right here, never
                # after transport, arrivals, or dwelling-release). Allocate
                # proportional to each cell's OWN remaining room instead, so
                # `amount_to_c = admit * room_per_cell[c] / total_room <=
                # room_per_cell[c]` always holds -- no cell can be
                # overshot regardless of how unevenly the door was occupied.
                for c in cells:
                    frac = room_per_cell[c] / total_room if total_room > 0 else 1.0 / len(cells)
                    share = admit * frac / dA
                    for dest_id, w in weights.items():
                        if dest_id in idx and w > 0:
                            rho[idx[dest_id]][c] += share * w
                n_in += admit

        # ---- clamp, and never clip silently (4.4/4.7) ----
        rho = np.where(walkable[None], rho, 0.0)
        dwell = np.where(walkable[None], dwell, 0.0)
        neg = np.minimum(rho, 0.0).sum()
        if neg < 0:
            n_clipped += float(neg * dA); rho = np.maximum(rho, 0.0)
        rho_tot = rho.sum(0) + dwell.sum(0)
        over = np.maximum(rho_tot - RHO_MAX, 0.0)
        if over.any():
            # This DELETES the excess (scales the cell down, counts the
            # difference as clipped) rather than pushing it to a neighbour
            # with room -- still true, and still the right thing to harden
            # further if a new leak ever shows up here. The one that WAS
            # showing up (circulation clipping >1% on real layouts) was
            # traced to entrance admission distributing people evenly
            # across a door's cells regardless of which ones actually had
            # room -- fixed at the source (see the entrance loop above);
            # this clamp hasn't fired on real runs since. A `_spread()`-style
            # overflow-relief pass here (vectorized -- this runs every one of
            # ~3000 steps per scenario call) is still the principled fallback
            # if some other injection path ever overshoots again.
            scale = np.where(rho_tot > 0, np.minimum(1.0, RHO_MAX / np.maximum(rho_tot, 1e-12)), 1.0)
            n_clipped += float((over * dA).sum())
            rho *= scale[None]; dwell *= scale[None]
            rho_tot = rho.sum(0) + dwell.sum(0)

        # ---- metrics + the cost function ----
        peak_rho = np.maximum(peak_rho, rho_tot)
        if phase == "egress":
            egress_peak_rho = np.maximum(egress_peak_rho, rho_tot)
        excess = rho_tot - rho_safe
        c_sev += float((np.maximum(excess, 0.0) ** COST_P).sum()) * dA * dt
        # softplus, stably: (1/k) ln(1 + e^{kx}) = (1/k) logaddexp(0, kx)
        c_smooth += float(np.logaddexp(0.0, COST_K * excess).sum()) / COST_K * dA * dt
        danger_run = np.where(rho_tot > RHO_D, danger_run + dt, 0.0)
        danger_ever |= danger_run > T_D

        if step % record_every == 0:
            u_x = sum(f * ex[k] * rho[k] for k in range(K))
            u_y = sum(f * ey[k] * rho[k] for k in range(K))
            denom = np.maximum(rho.sum(0), 1e-9)
            max_p = max(max_p, float(pressure_proxy(rho_tot, u_x / denom, u_y / denom, walkable).max()))
            if record_frames:
                frames.append(rho_tot.copy()); frame_t.append(t)

        # v0.2 4.9: for a phased run, T95 is EGRESS time -- seconds after
        # T_in, not from t=0 (ingress has no exits open, so N_out can't move
        # until the switch anyway; this just makes the reported number match
        # the doc's definition instead of always being T_in + something).
        if t95 is None and n_in > 0 and n_out >= 0.95 * n_in and phase in (None, "egress"):
            t95 = (step + 1) * dt - (phase_switch_t or 0.0)

        inside = float(rho_tot.sum() * dA)
        if inside <= 1e-6 * max(n_in, 1.0) and not any(q > 1e-9 for q in entr_queue.values()) \
                and (not cfg["inflow"] or step > 10):
            break

    inside = float((rho.sum(0) + dwell.sum(0)).sum() * dA)
    return {
        "_vg": vg, "_cfg": cfg, "dA": dA,       # for the DENSITY_MODEL hook
        "scenario": cfg["name"],
        "T95": t95 if t95 is not None else horizon,
        "T95_reached": t95 is not None,
        "A_danger": float(danger_ever.sum()) * dA,
        "max_P": max_p,
        "C_severity": c_sev,
        "C_smooth": c_smooth,
        "peak_rho": peak_rho,
        # v0.2 4.9: "report the ingress and egress peaks separately; the
        # first is the stage-front crush, the second the door bottleneck."
        # None on every scenario except "ingress_egress".
        "ingress_peak_rho": ingress_peak_rho,
        "egress_peak_rho": egress_peak_rho,
        "phase_switch_t": phase_switch_t,
        "rho_final": rho.sum(0) + dwell.sum(0),
        "n_in": n_in, "n_out": n_out, "n_inside": inside, "n_clipped": n_clipped,
        "ledger_error": n_in - inside - n_out - n_clipped,     # 4.7
        "disconnected": disconnected,
        "rejected": False, "reject_reason": "",
        "steps": step + 1,
        "area": vg.area,
        "incidents": [i["label"] for i in fired],
        "n_unplaced": n_unplaced,
        "frames": frames, "frame_t": frame_t,
    }


# --- DENSITY-MAP HOOK: the teammates' equation plugs in HERE ---------------
# The team is writing equations that take the venue's MAPS as input and
# return a DENSITY MAP, so the cost can be driven by maximum density. This
# slot is that interface. Contract:
#
#     rho_map = DENSITY_MODEL(vg, cfg, result)   ->  float[H, W], people/m^2
#
#   vg      -- sim.Venue: walkable mask, dx, exits, entrances, attractors
#   cfg     -- the scenario config from make_scenario() (classes, initial
#              population, inflow, transitions, incidents)
#   result  -- the simulator's output for this scenario (None if the sim was
#              not run), so a model may refine the sim's map or ignore it
#   input_maps(vg, cfg) hands over the raster channels most equations want.
#
# The default returns the simulator's own peak-density map, so everything
# works today; assign sim.DENSITY_MODEL = your_function (or pass
# density_model= to arena.simulate/objective) and the cost switches to your
# map with no other change anywhere.

def input_maps(vg, cfg):
    """Raster channels for a density model, design-doc factory style (S5):
    walkable, initial people/m^2, target mask per class, entrance rate map
    (people/s/m^2), exit mask, attractor draw map."""
    H, W = vg.walkable.shape
    dA = vg.dA
    maps = {
        "walkable": vg.walkable.astype(float),
        "initial_density": np.zeros((H, W)),
        "targets": np.zeros((len(cfg["classes"]), H, W)),
        "entrance_rate": np.zeros((H, W)),
        "exit_mask": np.zeros((H, W)),
        "attractor_draw": np.zeros((H, W)),
        "dx": vg.dx,
    }
    occ = np.zeros((H, W))
    for class_id, where in cfg["initial"].items():
        for zone_id, people in where.items():
            att = next((a for a in vg.attractors if a["id"] == zone_id), None)
            if att and people:
                _spread(maps["initial_density"], occ, vg.walkable, att["cells"], float(people), dA)
    for k, c in enumerate(cfg["classes"]):
        for cell in c["cells"]:
            maps["targets"][k][cell] = 1.0
    for e in vg.entrances:
        for cell in e["cells"]:
            maps["entrance_rate"][cell] += e["rate"] / (len(e["cells"]) * dA)
    for e in vg.exits:
        for cell in e["cells"]:
            maps["exit_mask"][cell] = 1.0
    for a in vg.attractors:
        for cell in a["cells"]:
            maps["attractor_draw"][cell] = max(maps["attractor_draw"][cell], a["draw"])
    return maps


# --- density-model REGISTRY -------------------------------------------
# More than one equation can answer "maps in, density map out" -- the full
# simulator (expensive, exact), a fast closed-form estimate (below), a
# learned one (unet.py), your teammates' formula, a future refinement of any
# of these. Register each under a name; `DENSITY_MODEL` is just whichever
# one is active. Add a new one anywhere in the codebase with:
#
#     @register_density_model("my_equation")
#     def my_equation(vg, cfg, result=None) -> np.ndarray[H, W]:
#         ...
#
# and it's immediately usable via DENSITY_MODELS["my_equation"] or
# arena.simulate(..., density_model=DENSITY_MODELS["my_equation"]) --
# nothing else in this file, or in appraise()/cost_from_density(), changes.

DENSITY_MODELS = {}

def register_density_model(name):
    def deco(fn):
        DENSITY_MODELS[name] = fn
        return fn
    return deco


@register_density_model("simulated_peak")
def simulated_peak_density(vg, cfg, result=None):
    """The ground truth: the simulator's max-over-time density map. Exact
    (up to numerics), expensive -- thousands of timesteps per call."""
    if result is None:
        result = run(vg, cfg)
    return result["peak_rho"]


# ---- fundamental-diagram inversion table, built once at import ----------
# q(rho) = rho * f(rho) rises to q_max at rho ~= 1.75/m^2 then falls (a
# traffic jam moves LESS flow than free-flowing traffic, not more). Only the
# rising (free-flow) branch is invertible without ambiguity; np.interp on it
# gives density from flux in one vectorized call across the whole grid.
_FD_RHO = np.linspace(1e-4, RHO_MAX, 4000)
_FD_Q = _FD_RHO * speed(_FD_RHO)
_FD_PEAK = int(np.argmax(_FD_Q))
_FD_RHO_ASC, _FD_Q_ASC = _FD_RHO[:_FD_PEAK + 1], _FD_Q[:_FD_PEAK + 1]
Q_MAX = float(_FD_Q_ASC[-1])   # ~1.22 people/(m.s), design doc 4.3

def _invert_flux_to_density(q):
    """q: flux per unit width, people/(m.s) -- array, any shape. Free-flow
    branch below capacity; a demand that EXCEEDS what the fundamental
    diagram can ever carry (q > Q_MAX) is a genuine bottleneck -- reported
    as RHO_MAX (jammed), not as a second, higher-density root, since there's
    no route-choice-aware way to say how far back the resulting queue
    extends without doing the queueing/backpressure pass this leaves open
    (see the module docstring below)."""
    q = np.asarray(q, dtype=float)
    rho = np.interp(np.minimum(q, Q_MAX), _FD_Q_ASC, _FD_RHO_ASC)
    return np.where(q > Q_MAX, RHO_MAX, rho)


def _accumulate_flux(walkable, phi, source):
    """Push `source` (people/s at each cell) downhill along `phi` from
    farthest to nearest, same accumulation rule as the dynamic transport
    step's flow physics, just for one static potential field instead of
    every timestep -- what makes this O(1 pass) instead of O(3000 steps)."""
    H, W = walkable.shape
    flux = source.copy()
    finite = np.isfinite(phi) & walkable
    order_key = np.where(finite, phi, -np.inf)
    order = np.dstack(np.unravel_index(np.argsort(-order_key, axis=None), phi.shape))[0]
    for r, c in order:
        if not finite[r, c] or flux[r, c] == 0:
            continue
        best, bd = None, phi[r, c]
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if 0 <= nr < H and 0 <= nc < W and walkable[nr, nc] and phi[nr, nc] < bd:
                    bd, best = phi[nr, nc], (nr, nc)
        if best:
            flux[best] += flux[r, c]
    return flux


def _scenario_supply_rates(vg, cfg):
    """Per-class steady-state source RATE maps, people/s -- what
    flux_inversion_density needs and the dynamic sim doesn't (it works in
    per-step deltas, not standing rates).

    Classes with an active entrance inflow get their EXACT rate (physically
    correct for a steady read: doors admitting at a constant people/min is
    already a rate). Classes that are only a fixed initial population with
    no inflow (evacuation, headliner -- there's no doorway feeding them) has
    no true steady-state rate to invert; T_REF (this file's own 300s
    evacuation-horizon constant) is used as a characteristic release time,
    which is a labeled approximation, not physics -- those two scenarios are
    exactly where 'not the right tool for a sudden spike' applies (see the
    docstring below); trust the dynamic sim for them and use this mainly as
    a fast cross-check."""
    H, W = vg.walkable.shape
    supply = {c["id"]: np.zeros((H, W)) for c in cfg["classes"]}

    for ent in vg.entrances:
        weights = cfg["inflow"].get(ent["id"])
        if not weights:
            continue
        cells = [c for c in ent["cells"] if vg.walkable[c]]
        if not cells:
            continue
        for dest_id, w in weights.items():
            if w > 0 and dest_id in supply:
                rate = ent["rate"] * w / len(cells)
                for c in cells:
                    supply[dest_id][c] += rate

    for class_id, where in cfg["initial"].items():
        if class_id not in supply:
            continue
        total = sum(where.values())
        if total <= 0:
            continue
        cells = []
        for zone_id, people in where.items():
            att = next((a for a in vg.attractors if a["id"] == zone_id), None)
            if att and people:
                cells += [c for c in att["cells"] if vg.walkable[c]]
        if cells:
            rate = total / T_REF / len(cells)
            for c in cells:
                supply[class_id][c] += rate

    return supply


@register_density_model("flux_inversion")
def flux_inversion_density(vg, cfg, result=None, iters=6, relax=0.6):
    """Idea #1 from the density-map discussion: a fast, closed-form,
    steady-state density estimate -- no time-stepping.

        1. solve the route field (eikonal -- same solver the dynamic sim
           uses) toward each class's destinations
        2. accumulate steady-state FLUX along it: how many people/s must
           cross each cell, given where everyone's headed
        3. invert the Weidmann fundamental diagram POINTWISE: a flux this
           high can only physically move through a cell at this density
           (or, if the flux exceeds what the diagram can ever carry, that
           cell is a bottleneck -- flag it as jammed)

    Iterated a few times with damping because congestion raises a cell's
    travel cost, which reroutes flux away from it, which changes the
    congestion there -- a small fixed-point relaxation. Still O(iters)
    eikonal solves, not O(3000) PDE timesteps: ~50-100x fewer numerical
    operations than run()'s full transient integration.

    LEFT OPEN, ON PURPOSE, for the next density-map idea to build on this
    one rather than replace it:
      - queueing/backpressure: right now an over-capacity cell is stamped
        RHO_MAX flat; a real queue backs up along the corridor BEHIND the
        bottleneck, cell by cell, until the accumulated queue is absorbed.
        That's a well-defined next pass over this same flux field -- walk
        upstream from every jammed cell and raise the density of its
        upstream neighbours by however much backed-up flow they're holding,
        rather than leaving them at their pre-jam free-flow estimate.
      - run-to-fixed-point: for scenarios with genuine ongoing inflow
        (circulation, ingress), reuse this function's `iters` loop as the
        STARTING density for run()'s dynamic solver, rather than starting
        it from empty -- should converge in far fewer of the 3000 timesteps.
      - this is exactly the DENSITY_MODEL contract, so a hand-derived
        equation from teammates, or a second learned model, registers the
        same way and the cost function does not change at all.

    ALSO LEFT OPEN, but fixed enough to be worth doing now: this only
    modeled people IN TRANSIT. A first pass without it correlated with the
    real simulator's peak-density map at r=0.045 on the circulation
    scenario -- because most of a circulation run's density isn't corridor
    traffic, it's people who already ARRIVED and are just standing at the
    bar or seated at a table (dwelling occupancy dominates, corridor flux is
    a comparatively small addition on top). `_occupancy_density()` below
    adds that static term back using the exact same zone-filling logic the
    dynamic sim uses at t=0 (`_spread`), so the two are apples-to-apples."""
    H, W = vg.walkable.shape
    supply = _scenario_supply_rates(vg, cfg)
    occupancy = _occupancy_density(vg, cfg)
    rho = occupancy.copy()
    for _ in range(iters):
        f = np.maximum(speed(rho), EPS_V)
        cost = 1.0 / f
        flux_total = np.zeros((H, W))
        for c in cfg["classes"]:
            src = supply.get(c["id"])
            tgt = [cell for cell in c["cells"] if vg.walkable[cell]]
            if src is None or not tgt or src.sum() <= 0:
                continue
            phi = eikonal(cost, vg.walkable, tgt, vg.dx)
            flux_total += _accumulate_flux(vg.walkable, phi, src)
        transit = _invert_flux_to_density(flux_total)
        new_rho = np.clip(occupancy + transit, 0.0, RHO_MAX)
        new_rho = np.where(vg.walkable, new_rho, 0.0)
        rho = relax * new_rho + (1 - relax) * rho
    return rho


def _occupancy_density(vg, cfg):
    """Static resting density: people who already ARRIVED and are standing
    at a bar or seated at a table, not currently walking anywhere. Mirrors
    run()'s own t=0 placement rule exactly (same `_spread`, same
    circulation-only condition) so this term means the same thing here as
    it does in the dynamic simulator, apples to apples."""
    H, W = vg.walkable.shape
    occ_field = np.zeros((H, W))
    if cfg["name"] != "circulation":
        return occ_field    # evacuation/headliner: everyone's moving, nobody's resting
    placed = np.zeros((H, W))
    for where in cfg["initial"].values():
        for zone_id, people in where.items():
            att = next((a for a in vg.attractors if a["id"] == zone_id), None)
            if att and people:
                _spread(occ_field, placed, vg.walkable, att["cells"], float(people), vg.dA)
    return occ_field


DENSITY_MODEL = DENSITY_MODELS["simulated_peak"]   # unchanged default -- opt into
                                                    # flux_inversion via density_model=


def cost_from_density(rho_map, dA, rho_safe=RHO_SAFE, p=COST_P, k=COST_K):
    """Hackathon.docx's penalty applied to ONE density map (no time sum):
    severity = sum max(0, rho - rho_safe)^p dA ;  smooth = softplus form."""
    excess = np.asarray(rho_map, dtype=float) - rho_safe
    return {
        "severity": float((np.maximum(excess, 0.0) ** p).sum()) * dA,
        "smooth": float(np.logaddexp(0.0, k * excess).sum()) / k * dA,
        "max_density": float(np.nanmax(rho_map)) if np.size(rho_map) else 0.0,
    }


def appraise(result, density_model=None, time_aware=True):
    """Score one scenario. `cost` is a function of ONE variable: density --
    still true here, just integrated over its full domain (space AND time)
    instead of collapsed to a peak-over-time snapshot first.

    Why this changed: the peak-density MAP (max_t rho at each cell) cannot
    tell a cell that was briefly crowded apart from one that stayed crowded
    the entire run -- both just show up as "reached X". Measured on a real
    before/after pair: the peak-map cost called it a 39% improvement, but a
    genuinely time-integrated view (area over rho_safe, summed over every
    second, not just ever-reached) showed only +3%, because the "after"
    layout was briefly WORSE before pulling ahead. Rewarding "shrink the
    area that ever gets crowded" without also rewarding "shorten how long
    it stays crowded" is a real gap in the metric, not a hypothetical one.

    The fix uses a quantity `run()` already computes exactly, correctly,
    every timestep: C_smooth = sum over every cell AND every step of the
    softplus excess-density penalty (Hackathon.docx's own smooth form) x
    cell area x dt. A cell over threshold for 3s contributes ~3s worth of
    penalty; a cell over threshold for 200s contributes ~200s worth. That
    IS "one variable, density" -- integrated over space and time, which is
    what a physical density field actually has, rather than reduced to a
    single number (its peak) before scoring it.

    For a DENSITY_MODEL that returns one static map (the fast flux-inversion
    estimate, or a future teammates' equation) there is no time series to
    integrate, so that map's pattern is treated as sustained for the whole
    scenario (the same approximation the old peak-map cost always implied);
    `time_aware=False` also selects this path explicitly.

    Nothing else is blended in: not T95, not the danger-area threshold
    count, not the velocity-based pressure proxy, not a disconnection or
    capacity-fit penalty. Those are still computed and returned because the
    design doc's 4.9 wants them reported, but none of them enter `cost`.

    Known tradeoff, still true, worth watching rather than hiding: a layout
    that traps a small, low-density pocket of people who can never reach an
    exit (`disconnected=True`) will not be penalized by `cost` if that
    pocket never gets dense enough to cross rho_safe. Filter on
    `disconnected` explicitly wherever a candidate layout is accepted or
    rejected -- don't rely on `cost` alone to catch it."""
    area = max(result["area"], 1e-9)
    model = density_model or DENSITY_MODEL
    using_default_model = density_model is None or density_model is DENSITY_MODEL

    if time_aware and using_default_model and result.get("steps", 0) > 0:
        # the real thing: an exact time integral, already computed per step
        span = max(result["steps"] * DT, DT)
        smooth = result["C_smooth"] / area / span
        severity = result["C_severity"] / area / span
        max_density = float(result["peak_rho"].max())
    else:
        # a static map (a hook model, or time_aware=False): its pattern is
        # assumed sustained for the whole run -- same approximation the
        # cost always made before this fix, kept as the fallback.
        rho_map = result.get("density_map")
        if rho_map is None:
            rho_map = model(result["_vg"], result["_cfg"], result) if "_vg" in result else result["peak_rho"]
            result["density_map"] = rho_map
        map_terms = cost_from_density(rho_map, result.get("dA", DX * DX))
        smooth, severity, max_density = map_terms["smooth"] / area, map_terms["severity"] / area, map_terms["max_density"]

    return {
        "cost": smooth,                                   # <- the ONE trained/optimized number
        "severity": severity,                              # same penalty, non-smooth twin (diagnostic)
        "max_density": max_density,
        # design doc 4.9 diagnostics -- reported, NOT part of cost
        "T95": result["T95"],
        "T95_reached": result["T95_reached"],
        "danger_frac": result["A_danger"] / area,
        "max_P": result["max_P"],
        "peak_rho": float(result["peak_rho"].max()),
        "disconnected": bool(result["disconnected"]),
        "rejected": bool(result.get("rejected", False)),
        "reject_reason": result.get("reject_reason", ""),
        "n_unplaced_frac": result.get("n_unplaced", 0.0) / max(result["n_in"], 1e-9),
        # v0.2 4.9: ingress vs. egress peaks, when this scenario has phases
        "ingress_peak": float(result["ingress_peak_rho"].max()) if result.get("ingress_peak_rho") is not None else None,
        "egress_peak": float(result["egress_peak_rho"].max()) if result.get("egress_peak_rho") is not None else None,
    }


def is_valid(terms, max_unplaced_frac=0.02):
    """Hard gate for candidate selection, kept SEPARATE from `cost` on
    purpose (see appraise()'s docstring) -- a layout that strands or can't
    fit its crowd should never be shipped, but that is a validity check, not
    another variable folded into the density cost."""
    return not terms["disconnected"] and terms["n_unplaced_frac"] <= max_unplaced_frac
