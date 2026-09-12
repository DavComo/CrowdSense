"""
sample_venue.py -- procedural venue generation, design doc S5:

    "three archetypes -- rectangular hall (2-4 exits), corridor-into-hall,
    hall with 1-4 rectangular obstacles -- with randomized dimensions, exit
    positions and widths, 2-4 entrances, 4-8 barrier slots, 1-3 gates."

Our optimizer's "barrier slots/gates" are movable walls/zones, not toggle
masks (D3 in the design doc is about a fixed-cell operational plan; ours is
continuous layout search per CLAUDE.md) -- so this generates movable
furniture instead, but the archetype variety and randomization are exactly
what S5 asks for. Output is real .crowdsense.json, same schema a human would
draw in the editor, so it exercises arena.py's generalization for real: if
`validate_venue.py` and the pipeline run clean on these, pack/unpack and
sim.py were not secretly still tied to the one hand-drawn fixture.

    python3 sample_venue.py --n 12 --out venues/generated
"""

import argparse
import datetime
import json
import os
import random

ARCHETYPES = ("rectangular_hall", "corridor_into_hall", "hall_with_obstacles")
COLORS = {"stage": "#e0564f", "bar": "#4f8fd6", "seating": "#8b7fe0", "merch": "#c9a15a",
          "restroom": "#8a8d94", "wall": "#c9cbd4", "entrance": "#5bb98c", "exit": "#e0564f"}


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _perimeter(w, h):
    return {"id": "wall_perimeter", "shape": "line",
            "points": [{"x": 0, "y": 0}, {"x": w, "y": 0}, {"x": w, "y": h},
                       {"x": 0, "y": h}, {"x": 0, "y": 0}],
            "thickness": 0.3, "color": COLORS["wall"], "movable": False, "extendable": False}


def _rect_wall(wid, x, y, w, h, movable=True, extendable=True):
    return {"id": wid, "shape": "rect", "x": x, "y": y, "w": w, "h": h,
            "color": COLORS["wall"], "movable": movable, "extendable": extendable}


def _zone(zid, ztype, name, x, y, w, h, capacity, stickiness, movable=True, extendable=True):
    return {"id": zid, "type": ztype, "name": name, "shape": "rect", "x": x, "y": y, "w": w, "h": h,
            "color": COLORS.get(ztype, "#8a8d94"), "capacity": capacity, "stickiness": stickiness,
            "movable": movable, "extendable": extendable}


def _point(pid, ptype, name, x, y, flow_rate):
    return {"id": pid, "type": ptype, "name": name, "x": x, "y": y, "flowRate": flow_rate,
            "color": COLORS.get(ptype, "#5bb98c"), "movable": False}


def _base_venue(name, w, h):
    return {"version": 1,
            "meta": {"name": name, "unit": "m", "createdAt": _now(), "updatedAt": _now()},
            "scale": {"pixelsPerUnit": 20}, "background": None,
            "walls": [_perimeter(w, h)], "zones": [], "points": []}


def _exits_on_perimeter(rng, w, h, n_exits, margin=1.5):
    """n_exits points spread across the 4 walls, each with a plausible flowRate."""
    sides = ["N", "S", "E", "W"]
    rng.shuffle(sides)
    pts = []
    for i in range(n_exits):
        side = sides[i % 4]
        if side == "N":
            x, y = rng.uniform(margin, w - margin), 0.0
        elif side == "S":
            x, y = rng.uniform(margin, w - margin), h
        elif side == "E":
            x, y = w, rng.uniform(margin, h - margin)
        else:
            x, y = 0.0, rng.uniform(margin, h - margin)
        width_m = rng.uniform(1.2, 3.0)
        flow = round(width_m / 1.5 * 90)      # ~ C_EXIT-scale door capacity, people/min
        kind = "emergency-exit" if i == n_exits - 1 else "exit"
        pts.append(_point(f"point_exit_{i}", kind, f"Exit {i+1}", x, y, flow if kind == "exit" else None))
    return pts


def _entrances(rng, w, h, n, margin=1.5):
    pts = []
    for i in range(n):
        x = rng.uniform(margin, w - margin)
        pts.append(_point(f"point_entrance_{i}", "entrance", f"Entrance {i+1}", x, h,
                          round(rng.uniform(60, 220))))
    return pts


def _populated_zones(rng, w, h, avoid, n_zones):
    """Zones placed to avoid a list of (x0,y0,x1,y1) rects, e.g. the stage.

    Capacity is CAPACITY DENSITY x AREA, not a fixed headcount independent
    of how big the zone turns out to be -- the original version could put a
    capacity:300 zone on a 3x2.5m footprint (40 people/m^2, well past even
    the physical jam density). Densities and stickiness below are
    calibrated against two things: published event-planning guidance
    (standing events run 6-12 sqft/person = 0.9-1.8 people/m^2; nightclub
    dance floors 2-3 sqft/person; seated dining 9-14 sqft/person) and the
    5 real venues in venues/from_gemini/, which independently cross-check
    at capacity/area = 0.6-0.9 people/m^2 despite being different venue
    types -- and real stickiness of 30-120 minutes, not the 6-22 minutes
    the fixed-multiplier version produced."""
    kinds = [("bar", (0.9, 1.6), (20, 45)), ("merch", (0.4, 0.8), (15, 30)),
             ("seating", (0.5, 1.0), (60, 120)), ("restroom", None, None)]
    rng.shuffle(kinds)
    zones = []
    MIN_CAP = 10   # a 3-person "zone" is a numerically-thin edge case (a real
                   # ledger error surfaced at n_in=4 total, ~2.5e-2 vs a 4e-3
                   # bar) and not a useful crowd-flow example either way --
                   # floor it rather than chase the edge case under pressure.
    for i in range(n_zones):
        ztype, density_range, stick_range = kinds[i % len(kinds)]
        # shrink the footprint on later attempts instead of giving up after
        # 20 tries at one size -- an obstacle-packed or small venue can
        # otherwise end with ZERO populated zones (a real failure seen with
        # the smaller, more realistic room sizes below), which is a venue
        # nobody can be simulated in at all.
        placed = False
        for shrink in (1.0, 0.6, 0.35):
            for _ in range(20):
                zw = rng.uniform(2.0 * shrink, max(2.0 * shrink, min(8, w * 0.35) * shrink))
                zh = rng.uniform(1.6 * shrink, max(1.6 * shrink, min(6, h * 0.3) * shrink))
                x, y = rng.uniform(0.5, max(0.6, w - zw - 0.5)), rng.uniform(0.5, max(0.6, h - zh - 0.5))
                if all(x + zw < a[0] or x > a[2] or y + zh < a[1] or y > a[3] for a in avoid):
                    cap = max(MIN_CAP, int(zw * zh * rng.uniform(*density_range))) if density_range else None
                    stick = int(rng.uniform(*stick_range)) if stick_range else None
                    zones.append(_zone(f"zone_{ztype}_{i}", ztype, f"{ztype.title()} {i+1}",
                                       x, y, zw, zh, cap, stick))
                    avoid = avoid + [(x, y, x + zw, y + zh)]
                    placed = True
                    break
            if placed:
                break
    return zones, avoid


def rectangular_hall(rng, seed):
    # 12-30m: real venues in venues/from_gemini/ run 12-22m/side; a real
    # 220-capacity nightclub example runs ~15x15m (WebSearch, 2026-09-12).
    # The upper end still covers a bigger club (this project's own 30x20m
    # reference venue).
    w, h = rng.uniform(12, 30), rng.uniform(11, 24)
    v = _base_venue(f"Generated Rectangular Hall #{seed}", w, h)
    n_exits = rng.randint(2, 4)
    v["points"] += _exits_on_perimeter(rng, w, h, n_exits)
    v["points"] += _entrances(rng, w, h, rng.randint(1, 3))
    n_obstacles = rng.randint(0, 2)
    avoid = []
    for i in range(n_obstacles):
        pw, ph = rng.uniform(0.6, 1.2), rng.uniform(0.6, 1.2)
        px, py = rng.uniform(2, w - 2), rng.uniform(2, h - 2)
        v["walls"].append(_rect_wall(f"wall_column_{i}", px, py, pw, ph, movable=False, extendable=False))
        avoid.append((px, py, px + pw, py + ph))
    zones, _ = _populated_zones(rng, w, h, avoid, rng.randint(2, 5))
    v["zones"] += zones
    return v


def corridor_into_hall(rng, seed):
    cw, ch = rng.uniform(2.5, 4.0), rng.uniform(6, 12)
    hw, hh = rng.uniform(11, 26), rng.uniform(10, 18)   # see rectangular_hall's note
    total_w, total_h = cw + hw, max(ch, hh)
    v = _base_venue(f"Generated Corridor+Hall #{seed}", total_w, total_h)
    # a wall separating the corridor from the hall, with a gap (implicit doorway)
    gap_y0 = (total_h - min(ch, hh)) / 2 + min(ch, hh) * 0.3
    v["walls"].append({"id": "wall_corridor_top", "shape": "line",
                       "points": [{"x": cw, "y": 0}, {"x": cw, "y": gap_y0}],
                       "thickness": 0.25, "color": COLORS["wall"], "movable": False, "extendable": False})
    v["walls"].append({"id": "wall_corridor_bot", "shape": "line",
                       "points": [{"x": cw, "y": gap_y0 + 3.0}, {"x": cw, "y": total_h}],
                       "thickness": 0.25, "color": COLORS["wall"], "movable": False, "extendable": False})
    v["points"].append(_point("point_entrance_0", "entrance", "Main Entrance", 0.2, total_h / 2,
                              round(rng.uniform(80, 180))))
    n_exits = rng.randint(2, 3)
    exits = []
    for i in range(n_exits):
        side_y = rng.uniform(1.5, total_h - 1.5)
        kind = "emergency-exit" if i == n_exits - 1 else "exit"
        flow = round(rng.uniform(1.2, 2.4) / 1.5 * 90) if kind == "exit" else None
        exits.append(_point(f"point_exit_{i}", kind, f"Exit {i+1}", total_w, side_y, flow))
    v["points"] += exits
    zones, _ = _populated_zones(rng, hw, hh, [], rng.randint(2, 4))
    for z in zones:                      # shift into the hall half of the venue
        z["x"] += cw
    v["zones"] += zones
    return v


def hall_with_obstacles(rng, seed):
    w, h = rng.uniform(13, 32), rng.uniform(12, 24)   # see rectangular_hall's note
    v = _base_venue(f"Generated Hall+Obstacles #{seed}", w, h)
    n_exits = rng.randint(2, 4)
    v["points"] += _exits_on_perimeter(rng, w, h, n_exits)
    v["points"] += _entrances(rng, w, h, rng.randint(1, 2))
    n_obstacles = rng.randint(1, 4)
    avoid = []
    for i in range(n_obstacles):
        ow, oh = rng.uniform(1.5, 4.0), rng.uniform(1.5, 4.0)
        ox, oy = rng.uniform(2, w - ow - 2), rng.uniform(2, h - oh - 2)
        v["walls"].append(_rect_wall(f"wall_block_{i}", ox, oy, ow, oh, movable=False, extendable=False))
        avoid.append((ox, oy, ox + ow, oy + oh))
    # one movable stage, since a hall archetype usually has a focal point
    sw, sh = rng.uniform(6, 12), rng.uniform(3, 6)
    sx, sy = w / 2 - sw / 2, 1.0
    v["zones"].append(_zone("zone_stage", "stage", "Stage", sx, sy, sw, sh, None, None,
                            movable=False, extendable=False))
    avoid.append((sx, sy, sx + sw, sy + sh))
    zones, _ = _populated_zones(rng, w, h, avoid, rng.randint(2, 5))
    v["zones"] += zones
    return v


GENERATORS = {"rectangular_hall": rectangular_hall, "corridor_into_hall": corridor_into_hall,
              "hall_with_obstacles": hall_with_obstacles}


def generate(n, seed=0, archetypes=ARCHETYPES):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        kind = archetypes[i % len(archetypes)]
        r = random.Random(seed * 10007 + i)
        out.append((kind, GENERATORS[kind](r, i)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=9)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="venues/generated")
    args = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, args.out)
    os.makedirs(out_dir, exist_ok=True)

    for kind, venue in generate(args.n, seed=args.seed):
        path = os.path.join(out_dir, f"{kind}_{venue['meta']['name'].split('#')[-1].strip()}.crowdsense.json")
        with open(path, "w") as f:
            json.dump(venue, f, indent=2)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
