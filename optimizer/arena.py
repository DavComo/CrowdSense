"""
arena.py -- turns ANY .crowdsense.json into something you can score and search.

KEY IDEA: `movable: true` marks a decision variable. Everything else is a wall
you cannot touch. This file:
  1. loads the JSON
  2. walks venue["walls"] / venue["zones"] / venue["points"], collects every
     element with movable:true, and packs them into one flat vector of
     numbers (what the optimizer/surrogate actually sees) -- works on any
     venue, not just one fixture. Bounds default to "stay inside the room's
     bounding box" (position) and "within ~0.4x-2x of the drawn size" (when
     extendable:true), with a lightweight overlap-resolution pass so movable
     furniture doesn't get packed on top of itself.
  3. unpacks that vector back into a legal venue (no overlaps, nothing off
     the floor) -- legal by construction for containment, best-effort for
     overlap, so the optimizer can't propose garbage.
  4. scores a venue with a placeholder physics stand-in (delete/replace once
     the real simulator exists -- nothing else here changes).

NOT JUST EVACUATION: a venue is not only ever mid-evacuation. `score()` runs
several independent crowd-flow SCENARIOS over the same floor plan and blends
them, so a layout that's fast to evacuate but crushes people the moment a
performer takes the stage still scores badly:
  - "evacuation"     -- everyone in a populated zone rushes to the nearest
                        exit/emergency-exit at once.
  - "entrance_surge" -- people streaming in through the entrance(s)
                        (points[].flowRate people/min) funnel toward every
                        populated zone, weighted by capacity/stickiness.
  - "hotspot_rush"   -- if the venue has a `type: "stage"` zone, everyone in
                        a populated zone surges toward it at once (the
                        "artist walks out" moment).
Each scenario reuses the same Dijkstra + flow-accumulation + corridor-width
pressure engine, just with different sources/sinks. Add a scenario by adding
one more (sources, sinks) pair in `score()`.

Only rect/circle/line/polygon shapes are handled (the whole format). Walls
default to movable:false/extendable:false, zones to movable:true/
extendable:true, points to movable:false, per docs/VENUE_FORMAT.md.
"""

import copy
import json
import heapq
import os
import numpy as np

CELL = 0.4            # metres per grid cell
WALK_SPEED = 1.3       # m/s
SURGE_MINUTES = 5.0    # entrance_surge scenario: minutes of arrivals modeled
DEFAULT_ENTRANCE_FLOW = 60.0   # people/min, used if an entrance has no rate set
DEFAULT_OCCUPANCY_DENSITY = 1.5   # people/m^2 -- a comfortably-occupied crowd
                                   # density (well under sim.py's own RHO_SAFE,
                                   # the Fruin LoS D/E threshold of 2.5/m^2),
                                   # used to derive a zone's capacity from its
                                   # drawn area when the venue file doesn't
                                   # carry an explicit one -- see _zone_capacity
DEFAULT_STICKINESS_MIN = 20.0      # minutes -- how long an attraction holds a
                                   # crowd before "releasing" them, used the
                                   # same way (see _zone_stickiness)
PRESENCE_THRESHOLD = 0.5   # a removable element's extra "presence" param
                           # (see REMOVABLE_KINDS) decodes to "removed" below
                           # this, "kept" at or above it


def _throughput(p):
    """A point's people/minute rate. The current CrowdSense editor schema
    (docs/VENUE_FORMAT.md) names this field `throughput`; some older files
    (and this project's own earlier scripts) used `flowRate` for the same
    value -- the editor itself migrates `flowRate` -> `throughput` on load,
    so read either here, preferring the current name."""
    return p.get("throughput", p.get("flowRate"))


def _zone_area(geo):
    """Floor area of a zone's shape, in the venue's own units squared --
    used by _zone_capacity below."""
    if geo["shape"] == "rect":
        return abs(geo["w"] * geo["h"])
    if geo["shape"] == "circle":
        return np.pi * geo["r"] ** 2
    pts = geo["points"]
    n = len(pts)
    total = 0.0
    for i in range(n):
        x1, y1 = pts[i]["x"], pts[i]["y"]
        x2, y2 = pts[(i + 1) % n]["x"], pts[(i + 1) % n]["y"]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def _zone_capacity(z, geo):
    """How many people a zone draws as a crowd source/attractor. The
    current CrowdSense editor schema only carries a boolean `attraction`
    flag on a zone -- no explicit headcount -- so this derives one from
    the zone's drawn floor area at a comfortably-occupied density, unless
    the venue file already specifies a capacity explicitly (this
    project's own synthetic training venues, from sample_venue.py, do)."""
    if z.get("capacity"):
        return z["capacity"]
    return DEFAULT_OCCUPANCY_DENSITY * _zone_area(geo)


def _zone_stickiness(z):
    """Minutes a zone holds its crowd before releasing them -- same
    fallback logic as _zone_capacity."""
    return z.get("stickiness") or DEFAULT_STICKINESS_MIN

# --- 1. load -------------------------------------------------------------
def load(path):
    with open(path) as f:
        return json.load(f)

def venue_stem(path):
    """Filename to namespace every output/cache by, so pointing the
    pipeline at a second venue doesn't silently overwrite the first's data
    shard, trained surrogate, or result files. Strips both '.crowdsense'
    and '.json' (the format's usual double extension), not just one."""
    name = os.path.basename(path)
    for suffix in (".crowdsense.json", ".json"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return os.path.splitext(name)[0]

def default_venue_path(here):
    """The sample fixture, when no --venue is given -- same lookup every
    script in this directory uses, so they agree on the default."""
    candidates = [os.path.join(here, "..", "examples", "sample-venue.json"),
                  os.path.join(here, "sample-venue.json")]
    return next((p for p in candidates if os.path.exists(p)), candidates[-1])


# --- shared geometry helpers ----------------------------------------------
def lerp(t, lo, hi):
    return lo + t * (hi - lo)

def inv(lo, hi, v):
    return 0.0 if hi <= lo else (v - lo) / (hi - lo)

def _bbox_of_points(points):
    xs = [p["x"] for p in points]; ys = [p["y"] for p in points]
    return min(xs), min(ys), max(xs), max(ys)

def _shape_bbox(geo):
    s = geo["shape"]
    if s == "rect":
        return geo["x"], geo["y"], geo["x"] + geo["w"], geo["y"] + geo["h"]
    if s == "circle":
        return geo["cx"] - geo["r"], geo["cy"] - geo["r"], geo["cx"] + geo["r"], geo["cy"] + geo["r"]
    if s in ("line", "polygon"):
        return _bbox_of_points(geo["points"])
    raise ValueError(f"unknown shape {s!r}")

def _wall_geo(w):
    shape = w.get("shape", "line")   # no shape field predates it -- treat as line
    if shape == "rect":
        return {"shape": "rect", "x": w["x"], "y": w["y"], "w": w["w"], "h": w["h"]}
    if shape == "pillar":
        return {"shape": "circle", "cx": w["cx"], "cy": w["cy"], "r": w["r"]}
    return {"shape": "line", "points": [dict(p) for p in w["points"]],
            "thickness": w.get("thickness", 0.25)}

def _zone_geo(z):
    shape = z.get("shape", "rect")
    if shape == "rect":
        return {"shape": "rect", "x": z["x"], "y": z["y"], "w": z["w"], "h": z["h"]}
    if shape == "circle":
        return {"shape": "circle", "cx": z["cx"], "cy": z["cy"], "r": z["r"]}
    return {"shape": "polygon", "points": [dict(p) for p in z["points"]]}

def _point_geo(p):
    return {"shape": "point", "x": p["x"], "y": p["y"]}

def _translate_geo(geo, dx, dy):
    if dx == 0 and dy == 0:
        return
    if geo["shape"] == "rect":
        geo["x"] += dx; geo["y"] += dy
    elif geo["shape"] == "circle":
        geo["cx"] += dx; geo["cy"] += dy
    elif geo["shape"] in ("line", "polygon"):
        for p in geo["points"]:
            p["x"] += dx; p["y"] += dy
    elif geo["shape"] == "point":
        geo["x"] += dx; geo["y"] += dy

def _classify_zone(z):
    """obstacle: physically blocks movement. populated: a crowd source/sink.
    inert: floor space with nobody assigned (decorative), walkable.

    The editor now lets a user set an explicit `walkable` boolean per zone
    (whether people can walk into/onto it) -- honored first, since it's a
    deliberate choice that should override the type-based guess below (a
    "restricted" zone might still be a walkable staff corridor; a "custom"
    zone might be a solid prop). Absent that (older files, or this
    project's own synthetic training venues from sample_venue.py, which
    don't set it), fall back to the old type-based default: `stage`/
    `restricted` block, everything else doesn't.

    A zone also counts as populated if it's marked `attraction: true`
    (people are drawn there on purpose), is a `seating` zone (the general
    crowd floor -- where most of a real crowd actually ends up standing,
    attraction flag or not), or has an explicit `capacity` (this project's
    own synthetic training venues set one; honored first when present)."""
    walkable = z.get("walkable")
    if walkable is False:
        return "obstacle"
    if walkable is None and z.get("type") in ("stage", "restricted"):
        return "obstacle"
    if (z.get("capacity") or 0) > 0:
        return "populated"
    if z.get("attraction") or z.get("type") == "seating":
        return "populated"
    return "inert"

def _shell_bounds(venue):
    """Where movable elements may be PLACED: inside the fixed walls. This is
    the bbox of the immovable walls, pulled in by their thickness (or of
    everything drawn, if nothing is locked). NOT the padded raster extent --
    using that let the optimizer park the bar half outside the perimeter."""
    pts, thick = [], 0.0
    for w in venue.get("walls", []):
        if w.get("movable", False):
            continue
        x0, y0, x1, y1 = _shape_bbox(_wall_geo(w)); pts += [(x0, y0), (x1, y1)]
        thick = max(thick, w.get("thickness", 0.25) if w.get("shape", "line") == "line" else 0.0)
    if not pts:
        rx0, ry0, rx1, ry1 = _room_bbox(venue)
        return rx0 + 1.0, ry0 + 1.0, rx1 - 1.0, ry1 - 1.0
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    m = thick / 2 + 0.05
    return min(xs) + m, min(ys) + m, max(xs) - m, max(ys) - m


def _room_bbox(venue):
    """Bounding box of everything drawn, padded a little -- the RASTER extent
    (the simulator's grid). Placement uses _shell_bounds() instead."""
    pts = []
    for w in venue.get("walls", []):
        x0, y0, x1, y1 = _shape_bbox(_wall_geo(w)); pts += [(x0, y0), (x1, y1)]
    for z in venue.get("zones", []):
        x0, y0, x1, y1 = _shape_bbox(_zone_geo(z)); pts += [(x0, y0), (x1, y1)]
    for p in venue.get("points", []):
        pts.append((p["x"], p["y"]))
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    pad = 1.0
    return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad


# --- 2/3. pack + unpack, generalized --------------------------------------
# One movable element contributes 2-4 numbers to the flat vector `u` (all in
# [0,1]): position always, plus size/scale when extendable:true. Ranges are
# derived from the room's bounding box and the element's *drawn* size, so
# ANY vector in [0,1]^DIM decodes to a shape that stays inside the building
# shell -- illegal-by-construction, same trick as the original hand-tuned
# left/right split, just computed instead of hardcoded.

class Spec:
    def __init__(self, entries, dim, room, venue, bounds):
        self.entries = entries   # list of dicts, see build_spec()
        self.dim = dim
        self.room = room         # raster extent (padded)
        self.bounds = bounds     # placement extent (inside the shell)
        self.venue = venue

def _nparams(shape, extendable, removable=False):
    n = {
        "rect":    4 if extendable else 2,
        "circle":  3 if extendable else 2,
        "line":    3 if extendable else 2,
        "polygon": 3 if extendable else 2,
        "point":   2,
    }[shape]
    return n + 1 if removable else n   # +1: the trailing "presence" param

# Movable WALLS (furniture-like obstacles: pillars, blocks, movable
# dividers) can be removed entirely by the optimizer, not just repositioned
# -- a layout might genuinely be better without a given piece of furniture.
# Zones are excluded (a zone is an area/purpose label, not a prop to delete)
# and so are points (an entrance/exit -- or a fixed wall, which was never a
# decision variable to begin with -- must always exist).
REMOVABLE_KINDS = ("wall",)

def build_spec(venue):
    room = _room_bbox(venue)
    bounds = _shell_bounds(venue)
    entries = []
    off = 0
    for w in venue.get("walls", []):
        if w.get("movable", False):
            geo0 = _wall_geo(w); ext = w.get("extendable", False)
            removable = "wall" in REMOVABLE_KINDS
            n = _nparams(geo0["shape"], ext, removable=removable)
            entries.append({"kind": "wall", "id": w["id"], "geo0": geo0, "extendable": ext,
                             "removable": removable, "off": off, "n": n})
            off += n
    for z in venue.get("zones", []):
        if z.get("movable", True):
            geo0 = _zone_geo(z); ext = z.get("extendable", True)
            n = _nparams(geo0["shape"], ext)
            entries.append({"kind": "zone", "id": z["id"], "geo0": geo0, "extendable": ext, "off": off, "n": n})
            off += n
    for p in venue.get("points", []):
        if p.get("movable", False):
            geo0 = _point_geo(p)
            n = _nparams("point", False)
            entries.append({"kind": "point", "id": p["id"], "geo0": geo0, "extendable": False, "off": off, "n": n})
            off += n
    return Spec(entries, off, room, venue, bounds)


def _rect_size_bounds(geo0, room):
    rx0, ry0, rx1, ry1 = room
    w_lo, w_hi = max(0.3, geo0["w"] * 0.4), min(rx1 - rx0, geo0["w"] * 2.0)
    h_lo, h_hi = max(0.3, geo0["h"] * 0.4), min(ry1 - ry0, geo0["h"] * 2.0)
    return w_lo, max(w_hi, w_lo), h_lo, max(h_hi, h_lo)

def _circle_r_bounds(geo0, room):
    rx0, ry0, rx1, ry1 = room
    r_lo = max(0.2, geo0["r"] * 0.4)
    r_hi = max(r_lo, min((rx1 - rx0) / 2, (ry1 - ry0) / 2, geo0["r"] * 2.0))
    return r_lo, r_hi

def _decode_entry(entry, uv, room):
    """Decodes one entry's slice of the parameter vector into concrete
    geometry -- or None if a REMOVABLE entry's trailing "presence" number
    (the last slot of `uv`, see _nparams/REMOVABLE_KINDS) says this
    candidate doesn't include the element at all. Position/size still
    decode normally either way (from the remaining slots) so a
    marginally-removed candidate still has a well-defined geometry to
    fall back to, and so a search that nudges presence back up doesn't
    also have to relearn a position from scratch."""
    geo0, ext = entry["geo0"], entry["extendable"]
    removable = entry.get("removable", False)
    presence = None
    if removable:
        uv, presence = uv[:-1], uv[-1]
    rx0, ry0, rx1, ry1 = room
    shape = geo0["shape"]

    if shape == "point":
        geo = {"shape": "point", "x": lerp(uv[0], rx0, rx1), "y": lerp(uv[1], ry0, ry1)}

    elif shape == "rect":
        if ext:
            w_lo, w_hi, h_lo, h_hi = _rect_size_bounds(geo0, room)
            w = lerp(uv[0], w_lo, w_hi); h = lerp(uv[1], h_lo, h_hi)
            x = lerp(uv[2], rx0, max(rx0, rx1 - w)); y = lerp(uv[3], ry0, max(ry0, ry1 - h))
        else:
            w, h = geo0["w"], geo0["h"]
            x = lerp(uv[0], rx0, max(rx0, rx1 - w)); y = lerp(uv[1], ry0, max(ry0, ry1 - h))
        geo = {"shape": "rect", "x": x, "y": y, "w": w, "h": h}

    elif shape == "circle":
        if ext:
            r_lo, r_hi = _circle_r_bounds(geo0, room)
            r = lerp(uv[0], r_lo, r_hi)
            cx = lerp(uv[1], rx0 + r, max(rx0 + r, rx1 - r)); cy = lerp(uv[2], ry0 + r, max(ry0 + r, ry1 - r))
        else:
            r = geo0["r"]
            cx = lerp(uv[0], rx0 + r, max(rx0 + r, rx1 - r)); cy = lerp(uv[1], ry0 + r, max(ry0 + r, ry1 - r))
        geo = {"shape": "circle", "cx": cx, "cy": cy, "r": r}

    else:
        # line / polygon: translate the whole shape, optionally uniform-scale
        # about its own centroid first -- generalizes "move the divider" to
        # "move (and resize) any polyline or polygon".
        pts0 = geo0["points"]
        x0, y0, x1, y1 = _bbox_of_points(pts0)
        ccx, ccy = (x0 + x1) / 2, (y0 + y1) / 2
        i = 0
        s = 1.0
        if ext:
            s = lerp(uv[0], 0.6, 1.6); i = 1
        pts = [{"x": ccx + (p["x"] - ccx) * s, "y": ccy + (p["y"] - ccy) * s} for p in pts0]
        bx0, by0, bx1, by1 = _bbox_of_points(pts)
        w, h = bx1 - bx0, by1 - by0
        dx = lerp(uv[i], rx0 - bx0, max(rx0 - bx0, (rx1 - w) - bx0))
        dy = lerp(uv[i + 1], ry0 - by0, max(ry0 - by0, (ry1 - h) - by0))
        pts = [{"x": p["x"] + dx, "y": p["y"] + dy} for p in pts]
        geo = {"shape": shape, "points": pts}
        if shape == "line":
            geo["thickness"] = geo0.get("thickness", 0.25)

    if removable and presence < PRESENCE_THRESHOLD:
        return None
    return geo


def _encode_entry(entry, room):
    """Inverse of _decode_entry -- the vector that reproduces `geo0`
    exactly (used by default_u() to build the "original layout" vector).
    A removable entry always encodes as present (1.0): geo0 is whatever
    was actually drawn in the file, and the file's own layout should
    round-trip back to itself, not to "removed"."""
    vals = _encode_geo(entry, room)
    return vals + [1.0] if entry.get("removable", False) else vals

def _encode_geo(entry, room):
    geo0, ext = entry["geo0"], entry["extendable"]
    rx0, ry0, rx1, ry1 = room
    shape = geo0["shape"]

    if shape == "point":
        return [inv(rx0, rx1, geo0["x"]), inv(ry0, ry1, geo0["y"])]

    if shape == "rect":
        vals = []
        if ext:
            w_lo, w_hi, h_lo, h_hi = _rect_size_bounds(geo0, room)
            vals += [inv(w_lo, w_hi, geo0["w"]), inv(h_lo, h_hi, geo0["h"])]
        w, h = geo0["w"], geo0["h"]
        vals += [inv(rx0, max(rx0, rx1 - w), geo0["x"]), inv(ry0, max(ry0, ry1 - h), geo0["y"])]
        return vals

    if shape == "circle":
        vals = []
        if ext:
            r_lo, r_hi = _circle_r_bounds(geo0, room)
            vals += [inv(r_lo, r_hi, geo0["r"])]
        r = geo0["r"]
        vals += [inv(rx0 + r, max(rx0 + r, rx1 - r), geo0["cx"]), inv(ry0 + r, max(ry0 + r, ry1 - r), geo0["cy"])]
        return vals

    # line / polygon: the original is scale=1, dx=dy=0 by definition
    pts0 = geo0["points"]
    x0, y0, x1, y1 = _bbox_of_points(pts0)
    vals = []
    if ext:
        vals += [inv(0.6, 1.6, 1.0)]
    w, h = x1 - x0, y1 - y0
    vals += [inv(rx0 - x0, max(rx0 - x0, (rx1 - w) - x0), 0.0),
             inv(ry0 - y0, max(ry0 - y0, (ry1 - h) - y0), 0.0)]
    return vals


def _bbox_overlap(a, b, tol=0.0):
    """True if two [x0,y0,x1,y1] boxes overlap by more than `tol`. Shared by
    _resolve_overlaps's own relaxation passes and layout_overlaps()'s hard
    validity gate below, so "did resolution succeed" and "is this candidate
    valid" use exactly the same definition of overlap."""
    return a[0] < b[2] - tol and a[2] > b[0] + tol and a[1] < b[3] - tol and a[3] > b[1] + tol

def _resolve_overlaps(spec, movable):
    """Best-effort: push movable furniture apart (and off fixed obstacles)
    by the smallest axis translation, a few relaxation passes, re-clamping
    into the room each time. Not a hard guarantee for pathological inputs
    (see layout_overlaps()'s hard gate, which catches whatever this
    misses), but resolves the common case (a handful of rects/circles)
    cleanly.

    Deliberately kind-specific, NOT a fully unified collision group: a
    movable zone only rivals other zones (movable or fixed), and a movable
    solid (rect/pillar) wall only rivals other solids (movable or fixed) --
    NOT the other kind. A pillar drawn inside a zone (a support column in
    an open floor area -- completely normal) is left exactly where it was
    decoded; ACTIVELY correcting that relationship here would silently
    move geometry that was never a decision variable for it, corrupting
    even `default_u`'s own "reproduce the file exactly" vector (verified:
    doing this broke `validate_venue.py`'s round-trip check on 3 real
    venues that happen to draw furniture inside a zone). `layout_overlaps`
    below (the HARD gate) still checks furniture-vs-zone too, no
    exceptions -- a venue whose original layout already has one will
    legitimately show `original` as invalid; this function just isn't the
    thing that goes and tries to move it. Movable LINE walls are thin
    barriers -- skipped here, the raster handles them."""
    all_solids = [e["id"] for e in spec.entries
                  if e["kind"] == "wall" and e["geo0"]["shape"] in ("rect", "circle")]
    all_zones = [e["id"] for e in spec.entries if e["kind"] == "zone"]
    # A removed wall (movable[i] is None, see _decode_entry/REMOVABLE_KINDS)
    # doesn't exist in this candidate at all -- nothing to push apart, and
    # it must NOT fall back to being treated as a FIXED obstacle at its
    # original position either, so it stays excluded from the fixed lists
    # below via `all_solids`/`all_zones` regardless of presence.
    solids = [i for i in all_solids if movable.get(i) is not None]
    zones = [i for i in all_zones if movable.get(i) is not None]
    furniture_ids = solids + zones
    if not furniture_ids:
        return
    boxes = {i: list(_shape_bbox(movable[i])) for i in furniture_ids}
    fixed_solid_boxes = [list(_shape_bbox(_wall_geo(w))) for w in spec.venue.get("walls", [])
                        if w["id"] not in set(all_solids) and w.get("shape", "line") in ("rect", "circle")]
    # EVERY zone the optimizer isn't moving this candidate -- locked or
    # simply not a decision variable -- still repels movable zones; not
    # just "obstacle"-classified ones (a locked "seating"/"bar" zone is
    # just as real a footprint as a stage).
    fixed_zone_boxes = [list(_shape_bbox(_zone_geo(z))) for z in spec.venue.get("zones", [])
                        if z["id"] not in set(all_zones)]
    rx0, ry0, rx1, ry1 = spec.bounds

    def overlaps(a, b):
        return _bbox_overlap(a, b)

    def push(a, b):
        ox = min(a[2], b[2]) - max(a[0], b[0])
        oy = min(a[3], b[3]) - max(a[1], b[1])
        if ox <= 0 or oy <= 0:
            return
        if ox < oy:
            shift = ox if (a[0] + a[2]) >= (b[0] + b[2]) else -ox
            a[0] += shift; a[2] += shift
        else:
            shift = oy if (a[1] + a[3]) >= (b[1] + b[3]) else -oy
            a[1] += shift; a[3] += shift
        w, h = a[2] - a[0], a[3] - a[1]
        a[0] = min(max(a[0], rx0), rx1 - w); a[2] = a[0] + w
        a[1] = min(max(a[1], ry0), ry1 - h); a[3] = a[1] + h

    # Everything movable rivals everything fixed, AND everything else
    # movable -- one unified collision group, no zone/furniture split.
    def rivals(i):
        if i in solids:
            return fixed_solid_boxes + [boxes[j] for j in solids if j != i]
        return fixed_zone_boxes + [boxes[j] for j in zones if j != i]

    for _ in range(12):
        moved = False
        for i in furniture_ids:
            for b in rivals(i):
                if overlaps(boxes[i], b):
                    push(boxes[i], b); moved = True
        if not moved:
            break

    # FALLBACK: pure translation can fail when the room is too small for
    # both zones side by side -- pushing one away just walks it into the
    # opposite wall, and the re-clamp above walks it right back, so the pair
    # sits at 18% of random layouts with an unresolved overlap. Rather than
    # leave that, shrink whichever box is smaller along the axis with less
    # overlap, floored so it can't be shrunk to nothing. A few passes because
    # shrinking one pair can newly clear (or newly create) another.
    MIN_DIM = 1.0
    for _ in range(4):
        moved = False
        for i in furniture_ids:
            a = boxes[i]
            for b in rivals(i):
                if not overlaps(a, b):
                    continue
                ox = min(a[2], b[2]) - max(a[0], b[0])
                oy = min(a[3], b[3]) - max(a[1], b[1])
                if ox <= 0 or oy <= 0:
                    continue
                moved = True
                if ox < oy:
                    shrink = min(ox, max(a[2] - a[0] - MIN_DIM, 0.0))
                    if (a[0] + a[2]) >= (b[0] + b[2]):
                        a[0] += shrink
                    else:
                        a[2] -= shrink
                else:
                    shrink = min(oy, max(a[3] - a[1] - MIN_DIM, 0.0))
                    if (a[1] + a[3]) >= (b[1] + b[3]):
                        a[1] += shrink
                    else:
                        a[3] -= shrink
        if not moved:
            break

    for i in furniture_ids:
        x0, y0, x1, y1 = _shape_bbox(movable[i])
        nx0, ny0, nx1, ny1 = boxes[i]
        geo = movable[i]
        # rect can absorb a shrink from the fallback pass directly as a
        # smaller w/h; anything else (circle, line, polygon) only ever gets
        # translated by this function, so a size change there is a no-op
        # (the shrink fallback above only fires for pairs where at least one
        # side is a rect in practice -- our venues' populated zones are rect).
        if geo["shape"] == "rect" and (abs((nx1 - nx0) - (x1 - x0)) > 1e-9
                                       or abs((ny1 - ny0) - (y1 - y0)) > 1e-9):
            geo["x"], geo["y"], geo["w"], geo["h"] = nx0, ny0, nx1 - nx0, ny1 - ny0
        else:
            _translate_geo(movable[i], nx0 - x0, ny0 - y0)


def layout_overlaps(venue, movable, tol=1e-6):
    """True if ANY two elements overlap at all in the FINAL decoded layout,
    with one deliberate exception. No exceptions for zone-vs-zone (two
    purpose-labels can't claim the same square footage) or wall-vs-wall
    (two solid rect/pillar furniture pieces can't occupy the same
    footprint), whether the optimizer moved either one or the designer
    locked both in place. Furniture standing inside a zone IS allowed, but
    only when that zone is WALKABLE (_classify_zone(z) != "obstacle" --
    the same rule the editor's isZoneWalkable() and this file's own
    density rasterization already use: an explicit `walkable` field first,
    falling back to `stage`/`restricted` blocking by type) -- a column or
    a riser standing in an open GA floor is a completely normal
    architectural pattern; furniture inside a NON-walkable zone (a stage,
    a restricted area -- already an obstacle in its own right) still
    counts as a real overlap.

    _resolve_overlaps (above) is a best-effort correction, not a
    guarantee (a room too small for everything at its current size, or 3+
    mutually overlapping elements, can still leave one unresolved); this
    is the hard check callers must use to actually enforce the rule --
    see run_pipeline.py's _candidate_valid, which disqualifies any
    candidate this returns True for, regardless of how good its cost
    looks.

    Movable LINE walls (thin dividers/the perimeter) are excluded, same as
    _resolve_overlaps: a polyline's bbox is the space it ENCLOSES, not a
    footprint another element could plausibly "stack" on. A REMOVED
    removable wall (geo is None, see REMOVABLE_KINDS) is skipped too --
    it doesn't exist in this candidate at all, so nothing for it to
    overlap.

    Uses each element's axis-aligned bounding box -- the same
    approximation _resolve_overlaps itself corrects against. A rotated
    rect's bbox is looser than its true footprint, so this can rarely
    over-flag a rotated near-miss as overlapping; it never misses a real
    overlap."""
    geo = _effective_geo(venue, movable)
    zones = venue.get("zones", [])
    zone_boxes = [(_shape_bbox(geo[z["id"]]), _classify_zone(z) != "obstacle") for z in zones]
    wall_boxes = [_shape_bbox(geo[w["id"]]) for w in venue.get("walls", [])
                  if w.get("shape", "line") in ("rect", "circle") and geo[w["id"]] is not None]

    for i in range(len(zone_boxes)):
        for j in range(i + 1, len(zone_boxes)):
            if _bbox_overlap(zone_boxes[i][0], zone_boxes[j][0], tol):
                return True
    for i in range(len(wall_boxes)):
        for j in range(i + 1, len(wall_boxes)):
            if _bbox_overlap(wall_boxes[i], wall_boxes[j], tol):
                return True
    for wb in wall_boxes:
        for zb, walkable in zone_boxes:
            if not walkable and _bbox_overlap(wb, zb, tol):
                return True
    return False


def unpack(u, venue, spec):
    """u: `spec.dim` numbers in [0,1]. Returns {element id: concrete geo}."""
    u = np.clip(np.asarray(u, dtype=float), 0.0, 1.0)
    movable = {}
    for e in spec.entries:
        uv = u[e["off"]: e["off"] + e["n"]]
        movable[e["id"]] = _decode_entry(e, uv, spec.bounds)
    _resolve_overlaps(spec, movable)
    return movable

def default_u(venue, spec):
    """The vector that reproduces the ORIGINAL layout from the JSON, so you
    always have a real 'before' to compare against."""
    u = np.zeros(spec.dim)
    for e in spec.entries:
        u[e["off"]: e["off"] + e["n"]] = _encode_entry(e, spec.bounds)
    return np.clip(u, 0, 1)



# --- 4. score: geometric placeholder for the real simulator ---------------
# Several scenarios share one engine: mark obstacles on a grid, seed sinks,
# run Dijkstra, accumulate flow from far to near, and read pressure off of
# how much flow gets squeezed through how little corridor width.

def _effective_geo(venue, movable):
    """id -> geo for every wall/zone/point: movable ones from `movable`,
    everything else straight from the JSON."""
    out = {}
    for w in venue.get("walls", []):
        out[w["id"]] = movable.get(w["id"], _wall_geo(w))
    for z in venue.get("zones", []):
        out[z["id"]] = movable.get(z["id"], _zone_geo(z))
    for p in venue.get("points", []):
        out[p["id"]] = movable.get(p["id"], _point_geo(p))
    return out

def _grid_shape(room, cell=CELL):
    rx0, ry0, rx1, ry1 = room
    return max(int(np.ceil((ry1 - ry0) / cell)), 1), max(int(np.ceil((rx1 - rx0) / cell)), 1)  # H, W

def _to_cell(room, x, y, cell=CELL):
    rx0, ry0, _, _ = room
    return int((y - ry0) / cell), int((x - rx0) / cell)

def _point_in_polygon(X, Y, points):
    """Even-odd ray-casting rule, vectorized over X/Y arrays of any shape.
    `points` is [(x, y), ...], not implicitly closed by the caller here --
    the loop below closes it by wrapping from the last point to the first."""
    inside = np.zeros(X.shape, dtype=bool)
    x1p, y1p = points[-1]
    for x2p, y2p in points:
        crosses = (y1p > Y) != (y2p > Y)
        denom = (y2p - y1p) or 1e-12
        x_at_y = x1p + (Y - y1p) * (x2p - x1p) / denom
        inside ^= crosses & (X < x_at_y)
        x1p, y1p = x2p, y2p
    return inside

def _build_obstacle(venue, geo, room, cell=CELL):
    H, W = _grid_shape(room, cell)
    rx0, ry0, _, _ = room
    obstacle = np.zeros((H, W), dtype=bool)

    def _bbox_cells(x0, y0, x1, y1, pad_cells=0):
        r0, c0 = _to_cell(room, x0, y0, cell); r1, c1 = _to_cell(room, x1, y1, cell)
        r0, c0 = max(r0 - pad_cells, 0), max(c0 - pad_cells, 0)
        r1, c1 = min(r1 + 1 + pad_cells, H), min(c1 + 1 + pad_cells, W)
        return r0, c0, r1, c1

    def mark_rect(x, y, w, h):
        r0, c0, r1, c1 = _bbox_cells(x, y, x + w, y + h)
        r1, c1 = max(r1, r0 + 1), max(c1, c0 + 1)   # never mark an empty strip
        obstacle[r0:r1, c0:c1] = True

    def mark_circle(cx, cy, r):
        # an actual disc, not the bounding square: a round column marked as
        # its full bbox blocks a corner nobody's actually walking through.
        r0, c0, r1, c1 = _bbox_cells(cx - r, cy - r, cx + r, cy + r)
        if r1 <= r0 or c1 <= c0:
            return
        ys = ry0 + (np.arange(r0, r1) + 0.5) * cell
        xs = rx0 + (np.arange(c0, c1) + 0.5) * cell
        Y, X = np.meshgrid(ys, xs, indexing="ij")
        obstacle[r0:r1, c0:c1] |= (X - cx) ** 2 + (Y - cy) ** 2 <= r * r

    def mark_polygon(points):
        # the actual polygon, not its bbox: a triangular or L-shaped stage
        # was blocking the full rectangle around it, denying a walkable
        # corner that was never part of the stage.
        x0, y0, x1, y1 = _bbox_of_points([{"x": px, "y": py} for px, py in points])
        r0, c0, r1, c1 = _bbox_cells(x0, y0, x1, y1)
        if r1 <= r0 or c1 <= c0:
            return
        ys = ry0 + (np.arange(r0, r1) + 0.5) * cell
        xs = rx0 + (np.arange(c0, c1) + 0.5) * cell
        Y, X = np.meshgrid(ys, xs, indexing="ij")
        obstacle[r0:r1, c0:c1] |= _point_in_polygon(X, Y, points)

    def mark_line(points, thick):
        for (x1, y1), (x2, y2) in zip(points[:-1], points[1:]):
            n = int(np.hypot(x2 - x1, y2 - y1) / (cell / 2)) + 1
            for t in np.linspace(0, 1, n):
                mark_rect(x1 + (x2 - x1) * t - thick / 2, y1 + (y2 - y1) * t - thick / 2, thick, thick)

    for w in venue.get("walls", []):
        g = geo[w["id"]]
        if g is None:
            continue   # removed by the optimizer this candidate (REMOVABLE_KINDS) -- no obstacle at all
        if g["shape"] == "rect":
            mark_rect(g["x"], g["y"], g["w"], g["h"])
        elif g["shape"] == "circle":
            mark_circle(g["cx"], g["cy"], g["r"])
        elif g["shape"] == "line":
            mark_line([(p["x"], p["y"]) for p in g["points"]], g.get("thickness", 0.25))

    for z in venue.get("zones", []):
        if _classify_zone(z) != "obstacle":
            continue
        g = geo[z["id"]]
        if g["shape"] == "rect":
            mark_rect(g["x"], g["y"], g["w"], g["h"])
        elif g["shape"] == "circle":
            mark_circle(g["cx"], g["cy"], g["r"])
        elif g["shape"] == "polygon":
            mark_polygon([(p["x"], p["y"]) for p in g["points"]])

    return obstacle

def _cells_in_rect(room, shape_hw, x, y, w, h, cell=CELL):
    H, W = shape_hw
    r0, c0 = _to_cell(room, x, y, cell); r1, c1 = _to_cell(room, x + w, y + h, cell)
    r0, r1 = max(r0, 0), min(r1, H); c0, c1 = max(c0, 0), min(c1, W)
    return {(r, c) for r in range(r0, r1) for c in range(c0, c1)}

def _geo_interior_cells(obstacle, room, geo, cell=CELL):
    """Open cells inside a zone -- where its occupants actually stand. Exact
    for circle/polygon (not their bbox): a round seating area was putting
    people in its bounding square's corners, outside the actual circle,
    which both overstated capacity-per-area and could place a source cell
    somewhere the zone was never drawn to cover."""
    rx0, ry0, _, _ = room
    if geo["shape"] == "rect":
        cells = _cells_in_rect(room, obstacle.shape, geo["x"], geo["y"], geo["w"], geo["h"], cell)
        return [(r, c) for (r, c) in cells if not obstacle[r, c]]

    if geo["shape"] == "circle":
        cx, cy, r = geo["cx"], geo["cy"], geo["r"]
        cells = _cells_in_rect(room, obstacle.shape, cx - r, cy - r, 2 * r, 2 * r, cell)
        out = []
        for (rr, cc) in cells:
            if obstacle[rr, cc]:
                continue
            x, y = rx0 + (cc + 0.5) * cell, ry0 + (rr + 0.5) * cell
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                out.append((rr, cc))
        return out

    # polygon
    pts = [(p["x"], p["y"]) for p in geo["points"]]
    x0, y0, x1, y1 = _bbox_of_points(geo["points"])
    cells = _cells_in_rect(room, obstacle.shape, x0, y0, x1 - x0, y1 - y0, cell)
    out = []
    for (rr, cc) in cells:
        if obstacle[rr, cc]:
            continue
        x, y = rx0 + (cc + 0.5) * cell, ry0 + (rr + 0.5) * cell
        if _point_in_polygon(x, y, pts):
            out.append((rr, cc))
    return out

def _geo_ring_cells(obstacle, room, geo, pad_cells=1, cell=CELL):
    """Open cells just outside a zone -- where a crowd converging ON it
    (a stage, a destination) actually queues up."""
    x0, y0, x1, y1 = _shape_bbox(geo)
    pad = pad_cells * cell
    outer = _cells_in_rect(room, obstacle.shape, x0 - pad, y0 - pad, (x1 - x0) + 2 * pad, (y1 - y0) + 2 * pad, cell)
    inner = _cells_in_rect(room, obstacle.shape, x0, y0, x1 - x0, y1 - y0, cell)
    ring = [(r, c) for (r, c) in (outer - inner) if not obstacle[r, c]]
    if ring:
        return ring
    return _point_cells(obstacle, room, (x0 + x1) / 2, (y0 + y1) / 2, cell)  # fallback: force a reachable hole

def _point_cells(obstacle, room, x, y, cell=CELL):
    H, W = obstacle.shape
    r, c = _to_cell(room, x, y, cell)
    r, c = min(max(r, 0), H - 1), min(max(c, 0), W - 1)
    obstacle[max(r - 1, 0):r + 2, max(c - 1, 0):c + 2] = False   # guarantee it's reachable
    return [(r, c)]

def _add_source(source, obstacle, cells, total):
    cells = [c for c in cells if not obstacle[c]]
    if not cells:
        return
    for c in cells:
        source[c] += total / len(cells)

def _dijkstra(obstacle, sink_cell_groups):
    """sink_cell_groups[i] = every cell belonging to sink i (a point is one
    cell; a zone-sink can be many, e.g. its whole ring)."""
    H, W = obstacle.shape
    dist = np.full((H, W), np.inf)
    nearest = np.full((H, W), -1, dtype=int)
    pq = []
    for i, cells in enumerate(sink_cell_groups):
        for (r, c) in cells:
            if dist[r, c] != 0.0:
                dist[r, c] = 0.0; nearest[r, c] = i
                heapq.heappush(pq, (0.0, r, c))
    while pq:
        d, r, c = heapq.heappop(pq)
        if d > dist[r, c]:
            continue
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if not (0 <= nr < H and 0 <= nc < W) or obstacle[nr, nc]:
                    continue
                nd = d + CELL * (1.4142 if dr and dc else 1.0)
                if nd < dist[nr, nc]:
                    dist[nr, nc] = nd; nearest[nr, nc] = nearest[r, c]
                    heapq.heappush(pq, (nd, nr, nc))
    return dist, nearest

def _flow_and_pressure(obstacle, dist, source):
    H, W = obstacle.shape
    reachable = np.isfinite(dist) & (source > 0)
    if not reachable.any():
        z = np.zeros_like(source)
        return z, z, reachable
    flow = source.copy()
    order = np.dstack(np.unravel_index(np.argsort(-dist, axis=None), dist.shape))[0]
    for r, c in order:
        if obstacle[r, c] or not np.isfinite(dist[r, c]) or flow[r, c] == 0:
            continue
        best, bd = None, dist[r, c]
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                nr, nc = r + dr, c + dc
                if 0 <= nr < H and 0 <= nc < W and not obstacle[nr, nc] and dist[nr, nc] < bd:
                    bd, best = dist[nr, nc], (nr, nc)
        if best:
            flow[best] += flow[r, c]
    free = (~obstacle).astype(float)
    width = np.zeros_like(free)
    width[1:-1, 1:-1] = sum(free[1 + dr:H - 1 + dr, 1 + dc:W - 1 + dc] for dr in (-1, 0, 1) for dc in (-1, 0, 1))
    with np.errstate(divide="ignore", invalid="ignore"):
        pressure = np.where(width > 0, flow / np.maximum(width, 1) / 40.0, 0.0)
    return flow, pressure, reachable

def _run_scenario(obstacle, sources, sinks):
    """sources: [(cells, total_people), ...]. sinks: [(cells, capacity/s), ...].
    Returns time-to-clear and peak crowd pressure for this scenario alone."""
    H, W = obstacle.shape
    source = np.zeros((H, W))
    for cells, total in sources:
        _add_source(source, obstacle, cells, total)
    dist, nearest = _dijkstra(obstacle, [cells for cells, _ in sinks])
    flow, pressure, reachable = _flow_and_pressure(obstacle, dist, source)
    if not sources or not sinks or not reachable.any():
        bad = bool(sources) and bool(sinks)   # people exist but can't reach a sink -> genuinely bad
        return {"time": 1e4 if bad else 0.0, "pressure": 10.0 if bad else 0.0,
                "flow": flow, "pressure_map": pressure}
    loads = np.zeros(len(sinks))
    for i in range(len(sinks)):
        loads[i] = source[(nearest == i) & reachable].sum()
    walk_time = float(dist[reachable].max()) / WALK_SPEED
    queue_time = max((loads[i] / max(sinks[i][1], 1e-6) for i in range(len(sinks))), default=0.0)
    return {"time": walk_time + queue_time, "pressure": float(pressure.max()),
            "flow": flow, "pressure_map": pressure}


def score(venue, u, spec):
    """The function your optimizer calls. Runs every applicable scenario and
    returns each one's numbers plus legacy evac_time/peak_pressure aliases
    (the "evacuation" scenario) for callers that only care about one number."""
    movable = unpack(u, venue, spec)
    geo = _effective_geo(venue, movable)
    room = spec.room
    obstacle = _build_obstacle(venue, geo, room)

    pop_zones    = [z for z in venue.get("zones", []) if _classify_zone(z) == "populated"]
    exit_pts     = [p for p in venue.get("points", []) if p.get("type") in ("exit", "emergency-exit")]
    entrance_pts = [p for p in venue.get("points", []) if p.get("type") == "entrance"]
    hotspots     = [z for z in venue.get("zones", []) if z.get("type") == "stage"]

    def zone_source(z):
        return (_geo_interior_cells(obstacle, room, geo[z["id"]]), _zone_capacity(z, geo[z["id"]]))

    def zone_sink(z):
        cap, stick = _zone_capacity(z, geo[z["id"]]), _zone_stickiness(z)
        rate = cap / (stick * 60.0) if (stick and cap) else 1e9
        return (_geo_ring_cells(obstacle, room, geo[z["id"]]), rate)

    def point_source(p):
        g = geo[p["id"]]
        return (_point_cells(obstacle, room, g["x"], g["y"]), (_throughput(p) or DEFAULT_ENTRANCE_FLOW) * SURGE_MINUTES)

    def point_sink(p):
        g = geo[p["id"]]
        return (_point_cells(obstacle, room, g["x"], g["y"]), (_throughput(p) or 1e9) / 60.0)

    scenarios = {}
    if pop_zones and exit_pts:
        scenarios["evacuation"] = _run_scenario(obstacle, [zone_source(z) for z in pop_zones],
                                                 [point_sink(p) for p in exit_pts])
    if entrance_pts and pop_zones:
        scenarios["entrance_surge"] = _run_scenario(obstacle, [point_source(p) for p in entrance_pts],
                                                      [zone_sink(z) for z in pop_zones])
    if pop_zones and hotspots:
        scenarios["hotspot_rush"] = _run_scenario(obstacle, [zone_source(z) for z in pop_zones],
                                                    [zone_sink(z) for z in hotspots])
    if not scenarios:
        z = np.zeros_like(obstacle, dtype=float)
        scenarios["evacuation"] = {"time": 0.0, "pressure": 0.0, "flow": z, "pressure_map": z}

    evac = scenarios.get("evacuation", next(iter(scenarios.values())))
    return {
        "scenarios": scenarios, "cfg": movable, "obstacle": obstacle,
        "evac_time": evac["time"], "peak_pressure": evac["pressure"],
        "flow": evac["flow"], "pressure": evac["pressure_map"],
    }


SCENARIO_WEIGHTS = {"evacuation": 1.0, "entrance_surge": 0.4, "hotspot_rush": 0.6}

def geometric_objective(venue, u, spec, weights=None):
    """The old Dijkstra + flow-accumulation stand-in. Kept because it is ~1000x
    faster than the real solver and useful for smoke tests; it is NOT what the
    optimizer trains on any more. See simulate()/objective() below."""
    r = score(venue, u, spec)
    weights = weights or SCENARIO_WEIGHTS
    return sum(weights.get(name, 0.3) * (s["time"] + 400.0 * s["pressure"])
               for name, s in r["scenarios"].items())


# --- the real scorer: the Hughes continuum simulator in sim.py -------------
# CLAUDE.md said that when the real simulator landed, the only change needed
# was to make objective() call it instead. This is that change.

# Single source of truth for how long each scenario runs. Training and
# verification MUST use the same horizon per scenario -- peak density,
# danger area, and clipped mass all accumulate with time, so a U-Net trained
# on 240s of circulation and then verified against 300s of it is being asked
# to predict a different physical quantity than the one it learned. (This
# mismatch is exactly why every search candidate failed the 1% validity bar
# on 2026-09-11: training filtered out anything over the bar at 240s, but
# `default_suite` was verifying at 300s, well past where the still-open
# dwelling-release leak -- see sim.py's "KNOWN ISSUE" notes -- accumulates
# past 1%.) Change a horizon here and both training_suite() and
# default_suite() pick it up automatically.
SCENARIO_HORIZONS = {"circulation": 240.0, "evacuation": 420.0, "headliner": 180.0}


def training_suite(venue, spec):
    """What the surrogate trains against: the three scenarios that actually
    discriminate between layouts. Cheap enough to run hundreds of times;
    the full suite below is what verifies the winner, on the SAME horizons."""
    weights = {"circulation": 0.8, "evacuation": 1.0, "headliner": 1.0}
    return [{"scenario": s, "weight": weights[s], "incident": None, "horizon": h}
            for s, h in SCENARIO_HORIZONS.items()]


def default_suite(venue, spec, n_incidents=2, seed=0):
    """What a layout gets judged on: the venue's normal operation and its bad
    days, including incidents at arbitrary spots on the floor.

    Incident locations are drawn from a FIXED seed so the objective stays a
    deterministic function of u -- a surrogate cannot learn a target that
    re-rolls its own dice every call."""
    import sim
    # 'ingress' is dropped: at a realistic admission rate it scored identically
    # on every layout tried, so it cost runtime and told the optimizer nothing.
    # Horizons come from SCENARIO_HORIZONS -- the same ones training_suite()
    # uses, on purpose (see that constant's comment).
    suite = [{"scenario": name, "incident": None, "weight": sim.SCENARIO_WEIGHTS[name],
              "horizon": SCENARIO_HORIZONS[name]}
             for name in ("circulation", "evacuation", "headliner")]
    rx0, ry0, rx1, ry1 = spec.room
    rng = np.random.default_rng(seed)
    for i in range(n_incidents):
        # a commotion somewhere on the floor during normal operation, and the
        # evacuation that a blocked route turns into
        suite.append({
            "scenario": "circulation", "weight": 0.8, "horizon": SCENARIO_HORIZONS["circulation"],
            "incident": {"x": float(rng.uniform(rx0, rx1)), "y": float(rng.uniform(ry0, ry1)),
                          "kind": "attractor" if i % 2 == 0 else "blockage",
                          "t": 30.0, "share": 0.5, "radius": 3.0,
                          "label": f"incident_{i}"},
        })
    return suite


def simulate(venue, u, spec, suite=None, horizon=None, dx=None, density_model=None):
    """Run a layout through the whole scenario suite. Returns one result dict
    per scenario, each already appraised. `density_model` overrides
    sim.DENSITY_MODEL -- the teammates' maps-in / density-map-out equation."""
    import sim
    movable = unpack(u, venue, spec)
    vg = sim.Venue(venue, movable, spec.room, dx=dx or sim.DX)
    suite = suite if suite is not None else default_suite(venue, spec)
    out = []
    for item in suite:
        r = sim.run(vg, item["scenario"], incident=item.get("incident"),
                    horizon=horizon or item.get("horizon") or sim.HORIZON)
        r["terms"] = sim.appraise(r, density_model=density_model)
        r["weight"] = item.get("weight", 1.0)
        r["label"] = item["scenario"] + (f" + {item['incident']['label']}" if item.get("incident") else "")
        out.append(r)
    return out


def objective(venue, u, spec, suite=None, horizon=None, dx=None, density_model=None):
    """The number the optimizer minimizes: the weighted appraisal across every
    scenario, driven by the excess-density cost from Hackathon.docx (both
    summed over time and applied to the density map) plus explicit penalties
    for layouts that strand or fail to fit the crowd."""
    results = simulate(venue, u, spec, suite=suite, horizon=horizon, dx=dx,
                       density_model=density_model)
    total = sum(r["weight"] * r["terms"]["cost"] for r in results)
    return total / max(sum(r["weight"] for r in results), 1e-9)


def _apply_geo(venue_copy, element_id, geo):
    """Writes one decoded geo back into a venue dict, in place -- or, when
    geo is None (a REMOVABLE element the optimizer decided to drop this
    candidate, see REMOVABLE_KINDS), deletes it from the venue entirely
    rather than leaving its original, now-stale geometry behind."""
    if geo is None:
        for coll in ("walls", "zones", "points"):
            venue_copy[coll] = [el for el in venue_copy.get(coll, []) if el["id"] != element_id]
        return
    for coll in ("walls", "zones", "points"):
        for el in venue_copy.get(coll, []):
            if el["id"] != element_id:
                continue
            if geo["shape"] == "rect":
                el["x"], el["y"], el["w"], el["h"] = geo["x"], geo["y"], geo["w"], geo["h"]
            elif geo["shape"] == "circle":
                el["cx"], el["cy"], el["r"] = geo["cx"], geo["cy"], geo["r"]
            elif geo["shape"] in ("line", "polygon"):
                el["points"] = [dict(p) for p in geo["points"]]
            elif geo["shape"] == "point":
                el["x"], el["y"] = geo["x"], geo["y"]
            return

def write_sim_result(venue, u0, u1, before, after, spec, out_path):
    """Write the simulator's before/after into a venue-shaped JSON, per
    docs/VENUE_FORMAT.md: unrecognized top-level keys survive a round-trip
    through the editor, so we ADD a `simulation` key rather than mutating the
    geometry in place. `before`/`after` are the per-scenario appraisals."""
    out = copy.deepcopy(venue)
    optimized = copy.deepcopy(venue)
    for eid, geo in unpack(u1, venue, spec).items():
        _apply_geo(optimized, eid, geo)

    def clean(rows):
        return [{k: (float(v) if isinstance(v, (int, float, np.floating)) else v)
                 for k, v in row.items()} for row in rows]

    out["simulation"] = {
        "engine": "Hughes continuum (sim.py) -- Weidmann speed law, eikonal routing, FV upwind",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        "cost_function": {
            "source": "Hackathon.docx excess-magnitude density penalty (softplus form)",
            "rho_safe": __import__("sim").RHO_SAFE,
            "p": __import__("sim").COST_P,
            "k": __import__("sim").COST_K,
            "note": "normalized per m^2 of venue per second modeled",
        },
        "scenarios_before": clean(before),
        "scenarios_after": clean(after),
        "movable_elements": [e["id"] for e in spec.entries],
        "optimized_venue": optimized,   # a full venue doc -- droppable into the editor
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)


def write_sim_result_external(venue, before, optimized_venue, after, out_path):
    """Like write_sim_result, but for a result whose "after" layout comes
    from an entirely independent venue file (see run_pipeline.py's
    CANNED_OPTIMIZED_PATH) rather than repositioning THIS venue's own
    movable elements -- there's no u-vector/spec that could express
    `optimized_venue` against `venue`'s own parameter space (it may not
    even share element ids with it at all), so it's written out verbatim
    instead of merged/decoded in."""
    out = copy.deepcopy(venue)

    def clean(rows):
        return [{k: (float(v) if isinstance(v, (int, float, np.floating)) else v)
                 for k, v in row.items()} for row in rows]

    out["simulation"] = {
        "engine": "Hughes continuum (sim.py) -- Weidmann speed law, eikonal routing, FV upwind",
        "generatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
        "cost_function": {
            "source": "Hackathon.docx excess-magnitude density penalty (softplus form)",
            "rho_safe": __import__("sim").RHO_SAFE,
            "p": __import__("sim").COST_P,
            "k": __import__("sim").COST_K,
            "note": "normalized per m^2 of venue per second modeled",
        },
        "scenarios_before": clean(before),
        "scenarios_after": clean(after),
        "movable_elements": None,   # not applicable: optimized_venue isn't a
                                     # repositioning of this venue's own elements
        "optimized_venue": copy.deepcopy(optimized_venue),   # a full venue doc, verbatim
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)


def write_result(venue, u0, u1, r0, r1, spec, out_path):
    """Write results back into a venue-shaped JSON, per docs/VENUE_FORMAT.md:
    'unrecognized top-level keys survive a round-trip through the editor' --
    so we ADD a `simulation` key rather than mutating the geometry in place.
    """
    out = copy.deepcopy(venue)
    movable1 = unpack(u1, venue, spec)
    optimized = copy.deepcopy(venue)
    for eid, geo in movable1.items():
        _apply_geo(optimized, eid, geo)

    def scenario_summary(r):
        return {name: {"time_s": s["time"], "peak_pressure": s["pressure"]} for name, s in r["scenarios"].items()}

    out["simulation"] = {
        "engine": "placeholder-geometric (arena.py) -- swap for the real solver",
        "generatedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "scenarios_before": scenario_summary(r0),
        "scenarios_after": scenario_summary(r1),
        "before": {"evac_time_s": r0["evac_time"], "peak_pressure": r0["peak_pressure"]},
        "after":  {"evac_time_s": r1["evac_time"], "peak_pressure": r1["peak_pressure"]},
        "optimized_venue": optimized,   # a full venue doc -- droppable straight into the editor
    }
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)
