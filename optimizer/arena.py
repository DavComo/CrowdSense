"""
arena.py -- turns the club-floor JSON into something you can score and search.

KEY IDEA: `movable: true` marks a decision variable. Everything else is a wall
you cannot touch. This file:
  1. loads the JSON
  2. packs the movable elements into one flat vector of numbers (what the
     optimizer/surrogate actually sees)
  3. unpacks that vector back into a legal venue (no overlaps, nothing off
     the floor, nothing through the stage) -- legal BY CONSTRUCTION, so the
     optimizer can never propose garbage
  4. scores a venue with a placeholder physics stand-in (delete `score` once
     the real simulator exists -- nothing else here changes)

NOTE on scope: this file's pack/unpack currently know the 4 movable elements
in examples/sample-venue.json by NAME (zone_pit, zone_bar, wall_riser_1,
wall_divider). It does not yet generalise to an arbitrary .crowdsense.json
with different movable elements -- that generalisation (walk venue["walls"]
+ venue["zones"], collect everything with movable:true, build the vector
dynamically) is the natural next step once this pipeline is trusted.
"""

import json
import numpy as np
import heapq

CELL = 0.4          # metres per grid cell
WALK_SPEED = 1.3     # m/s

# --- 1. load -----------------------------------------------------------
def load(path):
    with open(path) as f:
        return json.load(f)

# --- 2/3. pack + unpack --------------------------------------------------
# The vector is 14 numbers. Ranges are chosen so ANY vector in [0,1]^14
# decodes to a legal floor plan -- pit stays left of the stage's edge,
# bar/riser stay right of it and don't overlap each other, and the divider
# is clamped to sit between them. This is the same trick as a perimeter
# door position: make illegal designs simply inexpressible.

DIM = 14

def unpack(u, venue):
    """u: 14 numbers in [0,1]. Returns a dict of concrete shapes."""
    u = np.clip(np.asarray(u, dtype=float), 0.0, 1.0)

    def lerp(i, lo, hi):
        return lo + u[i] * (hi - lo)

    pit_w = lerp(0, 6, 16);  pit_h = lerp(1, 6, 12)
    pit_x = lerp(2, 0, 16 - pit_w);  pit_y = lerp(3, 8, 20 - pit_h)

    bar_w = lerp(4, 3, 8);   bar_h = lerp(5, 2, 6)
    bar_x = lerp(6, 17, 30 - bar_w);  bar_y = lerp(7, 0, 10 - bar_h)

    ris_w = lerp(8, 2, 8);   ris_h = lerp(9, 1, 4)
    ris_x = lerp(10, 17, 30 - ris_w);  ris_y = lerp(11, 10, 20 - ris_h)

    div_y2 = lerp(12, 2, 19)
    div_x  = min(lerp(13, 16.2, 29), bar_x - 0.5, ris_x - 0.5)
    div_x  = max(div_x, 16.2)

    return {
        "pit":     (pit_x, pit_y, pit_w, pit_h),
        "bar":     (bar_x, bar_y, bar_w, bar_h),
        "riser":   (ris_x, ris_y, ris_w, ris_h),
        "divider": (div_x, 0.0, div_x, div_y2),   # x1,y1,x2,y2
    }


def default_u(venue):
    """The vector that reproduces the ORIGINAL layout from the JSON, so you
    always have a real 'before' to compare against."""
    pit  = next(z for z in venue["zones"] if z["id"] == "zone_pit")
    bar  = next(z for z in venue["zones"] if z["id"] == "zone_bar")
    ris  = next(w for w in venue["walls"] if w["id"] == "wall_riser_1")
    div  = next(w for w in venue["walls"] if w["id"] == "wall_divider")

    def inv(lo, hi, v):
        return 0.0 if hi == lo else (v - lo) / (hi - lo)

    u = np.zeros(DIM)
    u[0] = inv(6, 16, pit["w"]);  u[1] = inv(6, 12, pit["h"])
    u[2] = inv(0, 16 - pit["w"], pit["x"]);  u[3] = inv(8, 20 - pit["h"], pit["y"])
    u[4] = inv(3, 8, bar["w"]);   u[5] = inv(2, 6, bar["h"])
    u[6] = inv(17, 30 - bar["w"], bar["x"]); u[7] = inv(0, 10 - bar["h"], bar["y"])
    u[8] = inv(2, 8, ris["w"]);   u[9] = inv(1, 4, ris["h"])
    u[10] = inv(17, 30 - ris["w"], ris["x"]); u[11] = inv(10, 20 - ris["h"], ris["y"])
    u[12] = inv(2, 19, div["points"][1]["y"])
    u[13] = inv(16.2, 29, div["points"][0]["x"])
    return np.clip(u, 0, 1)


# --- 4. score: geometric placeholder for the real simulator --------------
# People start in the pit and bar (weighted by capacity). They walk toward
# whichever exit is closer, and every obstacle -- including the divider and
# riser YOU place -- blocks the direct path. A gap that's too narrow makes
# a lot of "flow" squeeze through one cell: that's the pressure signal.

def _rasterize(venue, cfg):
    W, H = int(30 / CELL), int(20 / CELL)
    obstacle = np.zeros((H, W), dtype=bool)
    obstacle[0, :] = obstacle[-1, :] = True
    obstacle[:, 0] = obstacle[:, -1] = True

    def mark_rect(x, y, w, h):
        c0, c1 = int(x / CELL), int((x + w) / CELL)
        r0, r1 = int(y / CELL), int((y + h) / CELL)
        obstacle[max(r0,0):min(r1,H), max(c0,0):min(c1,W)] = True

    def mark_line(x1, y1, x2, y2, thick=0.3):
        n = int(np.hypot(x2 - x1, y2 - y1) / (CELL / 2)) + 1
        for t in np.linspace(0, 1, n):
            mark_rect(x1 + (x2-x1)*t - thick/2, y1 + (y2-y1)*t - thick/2, thick, thick)

    stage = next(z for z in venue["zones"] if z["id"] == "zone_stage")
    mark_rect(stage["x"], stage["y"], stage["w"], stage["h"])
    col = next(w for w in venue["walls"] if w["id"] == "wall_column_1")
    mark_rect(col["cx"] - col["r"], col["cy"] - col["r"], 2*col["r"], 2*col["r"])
    mark_rect(*cfg["riser"])
    mark_line(*cfg["divider"])

    source = np.zeros((H, W))
    def add_source(x, y, w, h, total):
        c0, c1 = max(int(x/CELL),0), min(int((x+w)/CELL),W)
        r0, r1 = max(int(y/CELL),0), min(int((y+h)/CELL),H)
        cells = obstacle[r0:r1, c0:c1] == False
        n = max(cells.sum(), 1)
        source[r0:r1, c0:c1][cells] += total / n

    pit_cap = next(z for z in venue["zones"] if z["id"] == "zone_pit").get("capacity") or 500
    bar_cap = next(z for z in venue["zones"] if z["id"] == "zone_bar").get("capacity") or 20
    add_source(*cfg["pit"], pit_cap)
    add_source(*cfg["bar"], bar_cap)

    sinks = []
    for p in venue["points"]:
        r, c = int(p["y"]/CELL), int(p["x"]/CELL)
        r, c = min(max(r,0),H-1), min(max(c,0),W-1)
        obstacle[max(r-1,0):r+2, max(c-1,0):c+2] = False
        # spec: flowRate is people PER MINUTE -- convert to people/sec here
        # so every rate in this file is in the same units.
        flow_per_min = p.get("flowRate") or 1e9
        sinks.append((r, c, flow_per_min / 60.0))

    return obstacle, source, sinks


def _dijkstra(obstacle, sinks):
    H, W = obstacle.shape
    dist = np.full((H, W), np.inf)
    nearest = np.full((H, W), -1, dtype=int)
    pq = []
    for i, (r, c, _) in enumerate(sinks):
        dist[r, c] = 0.0; nearest[r, c] = i
        heapq.heappush(pq, (0.0, r, c))
    while pq:
        d, r, c = heapq.heappop(pq)
        if d > dist[r, c]: continue
        for dr in (-1,0,1):
            for dc in (-1,0,1):
                if dr == 0 and dc == 0: continue
                nr, nc = r+dr, c+dc
                if not (0 <= nr < H and 0 <= nc < W) or obstacle[nr, nc]:
                    continue
                nd = d + CELL * (1.4142 if dr and dc else 1.0)
                if nd < dist[nr, nc]:
                    dist[nr, nc] = nd; nearest[nr, nc] = nearest[r, c]
                    heapq.heappush(pq, (nd, nr, nc))
    return dist, nearest


def score(venue, u):
    """The function your optimizer calls. Same shape as evaluate() before:
    in a venue config, out a dict with evac_time and peak_pressure."""
    cfg = unpack(u, venue)
    obstacle, source, sinks = _rasterize(venue, cfg)
    dist, nearest = _dijkstra(obstacle, sinks)

    reachable = np.isfinite(dist) & (source > 0)
    if not reachable.any():
        return {"evac_time": 1e4, "peak_pressure": 10.0, "cfg": cfg}

    # flow accumulation: push each cell's load one step toward its
    # lower-distance neighbour, in order from farthest to nearest.
    flow = source.copy()
    H, W = obstacle.shape
    order = np.dstack(np.unravel_index(np.argsort(-dist, axis=None), dist.shape))[0]
    for r, c in order:
        if obstacle[r, c] or not np.isfinite(dist[r, c]) or flow[r, c] == 0:
            continue
        best, bd = None, dist[r, c]
        for dr in (-1,0,1):
            for dc in (-1,0,1):
                if dr == 0 and dc == 0: continue
                nr, nc = r+dr, c+dc
                if 0 <= nr < H and 0 <= nc < W and not obstacle[nr, nc] and dist[nr, nc] < bd:
                    bd, best = dist[nr, nc], (nr, nc)
        if best:
            flow[best] += flow[r, c]

    # local corridor width = free cells in a 3x3 window; pressure spikes
    # where a lot of flow is squeezed through a narrow gap
    free = (~obstacle).astype(float)
    width = np.zeros_like(free)
    width[1:-1,1:-1] = sum(free[1+dr:H-1+dr, 1+dc:W-1+dc]
                            for dr in (-1,0,1) for dc in (-1,0,1))
    with np.errstate(divide="ignore", invalid="ignore"):
        pressure = np.where(width > 0, flow / np.maximum(width, 1) / 40.0, 0.0)

    loads = np.zeros(len(sinks))
    for i in range(len(sinks)):
        loads[i] = source[(nearest == i) & reachable].sum()
    walk_time = float(dist[reachable].max()) / WALK_SPEED if reachable.any() else 0.0
    queue_time = max((loads[i] / sinks[i][2] for i in range(len(sinks))), default=0.0)

    return {
        "evac_time": walk_time + queue_time,
        "peak_pressure": float(pressure.max()),
        "cfg": cfg,
        "obstacle": obstacle, "flow": flow, "pressure": pressure,
    }


def objective(venue, u):
    r = score(venue, u)
    return r["evac_time"] + 400.0 * r["peak_pressure"]


def write_result(venue, u0, u1, r0, r1, out_path):
    """Write results back into a venue-shaped JSON, per docs/VENUE_FORMAT.md:
    'unrecognized top-level keys survive a round-trip through the editor' --
    so we ADD a `simulation` key rather than mutating the geometry in place.
    This file stays openable in the editor; the team can see the optimized
    layout as an overlay without it ever being mistaken for a hand-drawn one.
    """
    import copy
    out = copy.deepcopy(venue)
    cfg0, cfg1 = unpack(u0, venue), unpack(u1, venue)

    def apply(v, cfg):
        for z in v["zones"]:
            if z["id"] == "zone_pit":
                z["x"], z["y"], z["w"], z["h"] = cfg["pit"]
            if z["id"] == "zone_bar":
                z["x"], z["y"], z["w"], z["h"] = cfg["bar"]
        for w in v["walls"]:
            if w["id"] == "wall_riser_1":
                w["x"], w["y"], w["w"], w["h"] = cfg["riser"]
            if w["id"] == "wall_divider":
                x1, y1, x2, y2 = cfg["divider"]
                w["points"] = [{"x": x1, "y": y1}, {"x": x2, "y": y2}]

    optimized = copy.deepcopy(venue)
    apply(optimized, cfg1)

    out["simulation"] = {
        "engine": "placeholder-geometric (arena.py) -- swap for the real solver",
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "before": {"evac_time_s": r0["evac_time"], "peak_pressure": r0["peak_pressure"]},
        "after":  {"evac_time_s": r1["evac_time"], "peak_pressure": r1["peak_pressure"]},
        "optimized_venue": optimized,   # a full venue doc -- droppable straight into the editor
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
