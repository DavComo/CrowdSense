// A first-order continuum crowd-flow simulator (corrected Hughes model),
// following crowd_flow_design_v0.2.md sections 4.1–4.7. Runs entirely on
// the four grids already produced by masks.js — walkability (the domain:
// W·(1−Bk) in the design doc's notation), barrier (unused directly here;
// it's already folded into the walkability domain), entrance/exit rate,
// and attraction — so it's the direct downstream consumer of that module.
// Pure data-in/data-out, no DOM dependency, same spirit as masks.js.
//
// Scope notes (deliberate simplifications for an interactive editor
// feature, not the offline batch-training pipeline the design doc's
// Python modules are for):
//  - The route-direction field `e = −∇φ/‖∇φ‖` (4.2/4.5) *is* computed and
//    stored (`computeRouteDirection`, via central differences of φ, same
//    as scikit-fmm's `direction()` in the reference implementation) —
//    an earlier version of this file skipped it and instead pushed the
//    full f(ρ) through every face whose neighbor merely had lower φ,
//    which over-transports on any diagonal route and has no way to
//    express a single coherent direction; density came out looking like
//    it was diffusing/filling outward rather than flowing toward a
//    target. See the comment on `computeRouteDirection` for the full
//    reasoning.
//  - The routing/eikonal domain is exactly the walkability mask (already
//    "W·(1−Bk)" by construction — see masks.js) — barriers and the fixed
//    shell are both static for one run, so there's no mid-run
//    barrier-appears/move-the-trapped-density bookkeeping (4.6's N_moved).
//  - No full layout.is_connected preflight; the run always attempts the
//    simulation and surfaces lenient warnings (no entrances/no exits)
//    instead of hard-rejecting — appropriate for an interactive "let me
//    see what happens" tool rather than an automated data factory.
//  - The "maximum number of people" the caller picks is the ingress→egress
//    trigger: entrances admit (per the rate map) until that many people
//    have been let in, then routing targets switch to the exits for the
//    rest of the run — exits are already sinks throughout, per 4.6.

import {
  computeWalkabilityGrid, computeAttractionMask, computeEntranceExitMask, computeZoneFootprintMask,
  DEFAULT_THROUGHPUT,
} from './masks.js';
import {
  distance, pointToSegmentDistance, rectBounds, rectCenter, rotatePoint,
} from '../canvas/geometry.js';
import { isZoneWalkable } from '../model/schema.js';

export const PHYSICS_DEFAULTS = {
  vMax: 1.34, // m/s, Weidmann free-flow speed
  gamma: 1.913, // /m^2, Weidmann shape parameter
  rhoMax: 5.4, // people/m^2, modeled standstill density — not a safe-occupancy limit
  epsV: 0.05, // m/s, regularizes the eikonal solve only (never used for transport)
  // Steps between eikonal re-solves. MUST be 1 (every step) — recomputing
  // only periodically doesn't just lag the routing, it actively causes
  // large-amplitude oscillation, and this was the actual dominant source
  // of "pulsing" at higher densities (the CFL/substep fix elsewhere in
  // this file only fixed a much smaller secondary contributor). Congested
  // cells route by travel TIME (routeSpeed uses the CURRENT, density-
  // reduced speed), so as a crowd builds up unevenly, a periodic re-solve
  // can find a *discontinuously different* "fastest" direction from the
  // one currently in use — a real jump, not a gradual correction — and
  // undoing that jump at the NEXT re-solve (now that flow moved and
  // congestion shifted) creates a genuine flip-flop feedback loop,
  // amplitude bounded only by rhoMax, repeating every `routeRecomputeEvery`
  // steps. Measured directly on the sample club floor venue (200 ppl/min
  // entrance, 1000 max people, 300s): recomputing every 10 steps (the old
  // default) left cells swinging across virtually the ENTIRE density range
  // (rhoMax down to near 0) every single recorded frame; every 5 steps was
  // WORSE (larger, less frequent swings resonating with the recording
  // cadence); only recomputing every step brought the worst steady-state
  // swing down by an order of magnitude (to a few tenths of a people/m²,
  // consistent with ordinary MUSCL grid noise) — recomputing more often
  // approximates the true continuously-adaptive routing the design calls
  // for, instead of periodically discarding and re-deciding it in one
  // discrete jump.
  routeRecomputeEvery: 1,
};

export const MAX_SIM_STEPS = 20_000; // guard rail, same spirit as masks.js's MAX_GRID_CELLS

/** Weidmann/Kladek speed law f(ρ) (4.3): free-flow at ρ=0, decaying to 0 at
 * ρ_max. Clamped defensively — ρ should never exceed ρ_max entering this
 * (the step loop clamps it every step), but floating point is floating
 * point. */
export function speedFn(rho, { vMax, gamma, rhoMax } = PHYSICS_DEFAULTS) {
  const invRho = rho > 0 ? 1 / rho : Infinity;
  const invRhoMax = 1 / rhoMax;
  const value = vMax * (1 - Math.exp(-gamma * (invRho - invRhoMax)));
  return Math.min(vMax, Math.max(0, value));
}

/** Specific flow q(ρ) = ρ·f(ρ) — the fundamental-diagram curve (4.3). */
export function specificFlow(rho, params = PHYSICS_DEFAULTS) {
  return rho * speedFn(rho, params);
}

/** Minmod slope limiter: picks whichever of two candidate slopes is
 * shallower, or 0 if they disagree in sign (a local extremum — any
 * nonzero slope there would over/undershoot). The standard, most
 * diffusion-safe choice of limiter for a MUSCL reconstruction — see
 * `slopeX`/`slopeY` in the transport step below. */
function minmod(a, b) {
  if (a * b <= 0) return 0;
  return Math.abs(a) < Math.abs(b) ? a : b;
}

// --- Eikonal routing (4.5) --------------------------------------------------

/** Lazy-deletion binary min-heap of (key, index) pairs — avoids needing a
 * decrease-key operation: a cell can be pushed more than once as its
 * estimate improves, and a stale pop (key doesn't match the current best
 * for that index) is just skipped. */
class MinHeap {
  constructor() {
    this._keys = [];
    this._vals = [];
  }
  get size() { return this._keys.length; }
  push(key, val) {
    this._keys.push(key);
    this._vals.push(val);
    let i = this._keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._keys[parent] <= this._keys[i]) break;
      this._swap(parent, i);
      i = parent;
    }
  }
  pop() {
    const topKey = this._keys[0];
    const topVal = this._vals[0];
    const lastKey = this._keys.pop();
    const lastVal = this._vals.pop();
    if (this._keys.length > 0) {
      this._keys[0] = lastKey;
      this._vals[0] = lastVal;
      let i = 0;
      const n = this._keys.length;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let smallest = i;
        if (l < n && this._keys[l] < this._keys[smallest]) smallest = l;
        if (r < n && this._keys[r] < this._keys[smallest]) smallest = r;
        if (smallest === i) break;
        this._swap(i, smallest);
        i = smallest;
      }
    }
    return { key: topKey, val: topVal };
  }
  _swap(i, j) {
    [this._keys[i], this._keys[j]] = [this._keys[j], this._keys[i]];
    [this._vals[i], this._vals[j]] = [this._vals[j], this._vals[i]];
  }
}

/**
 * Fast Marching Method solve of ‖∇φ‖ = 1/speed, φ = 0 on target cells,
 * restricted to `domainMask` (4-connectivity only — 8-connectivity would
 * let φ cut across a wall/barrier corner diagonally, which the design doc
 * explicitly calls out to avoid). `speedField` is people-flow speed
 * (already max(f(ρ), ε_v) per cell) — pass a uniform array of vMax for the
 * very first solve, when ρ is still all zero.
 */
export function solveEikonal(domainMask, targetMask, speedField, cols, rows, cellSize) {
  const n = cols * rows;
  // Float64: the lazy-deletion heap's staleness check compares a freshly
  // computed key against the value read back from this array, so it must
  // match at full JS-number precision — a Float32Array's rounding (~7
  // significant digits) was enough to make every popped entry look stale
  // and silently stop the wavefront after one ring.
  const phi = new Float64Array(n).fill(Infinity);
  const known = new Uint8Array(n);

  const inDomain = (i) => domainMask[i] === 1;

  const heap = new MinHeap();
  for (let i = 0; i < n; i++) {
    if (inDomain(i) && targetMask[i]) { phi[i] = 0; known[i] = 1; }
  }

  const considerNeighborsOf = (i) => {
    const col = i % cols;
    const row = (i / cols) | 0;
    const neighbors = [];
    if (col > 0) neighbors.push(i - 1);
    if (col < cols - 1) neighbors.push(i + 1);
    if (row > 0) neighbors.push(i - cols);
    if (row < rows - 1) neighbors.push(i + cols);
    for (const j of neighbors) {
      if (!inDomain(j) || known[j]) continue;
      const est = eikonalUpdate(j, phi, domainMask, speedField, cols, rows, cellSize);
      if (est < phi[j]) {
        phi[j] = est;
        heap.push(est, j);
      }
    }
  };

  for (let i = 0; i < n; i++) if (known[i]) considerNeighborsOf(i);

  while (heap.size > 0) {
    const { key, val: i } = heap.pop();
    if (known[i] || key > phi[i] + 1e-9) continue; // stale entry
    known[i] = 1;
    considerNeighborsOf(i);
  }

  return phi;
}

function eikonalUpdate(idx, phi, domainMask, speedField, cols, rows, cellSize) {
  const col = idx % cols;
  const row = (idx / cols) | 0;
  let a = Infinity;
  if (col > 0 && domainMask[idx - 1]) a = Math.min(a, phi[idx - 1]);
  if (col < cols - 1 && domainMask[idx + 1]) a = Math.min(a, phi[idx + 1]);
  let b = Infinity;
  if (row > 0 && domainMask[idx - cols]) b = Math.min(b, phi[idx - cols]);
  if (row < rows - 1 && domainMask[idx + cols]) b = Math.min(b, phi[idx + cols]);

  const speed = Math.max(speedField[idx], 1e-6);
  const h = cellSize;
  const hf = h / speed;

  if (a === Infinity && b === Infinity) return Infinity;
  if (a === Infinity) return b + hf;
  if (b === Infinity) return a + hf;

  // Standard first-order FMM quadratic update: (φ-a)² + (φ-b)² = (h/F)².
  const disc = 2 * hf * hf - (a - b) * (a - b);
  if (disc < 0) return Math.min(a, b) + hf; // 1D fallback when the 2D solve has no real root
  return (a + b + Math.sqrt(disc)) / 2;
}

/**
 * Route direction e = −∇φ/‖∇φ‖ (4.2/4.5) via central differences of φ, one-
 * sided at a wall/domain edge, falling back to "point at the lowest-φ
 * neighbor" on a flat spot away from a target (4.5's zero-gradient rule).
 * A target cell itself (φ=0) or a disconnected one (φ=∞) gets e=(0,0) — no
 * route, no motion — matching "on target cells u=0" (4.5).
 *
 * This is genuinely a vector, not a scalar: on a diagonal route, ex and ey
 * are each a *fraction* of the full speed (e.g. ~0.71 apiece at 45°), not
 * the full magnitude on both axes. Skipping this step and instead pushing
 * the full f(ρ) through every face whose neighbor merely has lower φ (an
 * earlier version of this function did exactly that) transports up to
 * √2× too much mass through open, unobstructed area and has no way to
 * express a single coherent direction of travel — density comes out
 * looking like it's diffusing/filling outward toward the target rather
 * than flowing toward it, especially away from corridors where it isn't
 * pinned to one axis. This is the vector this module was missing.
 */
function computeRouteDirection(phi, domainMask, cols, rows, cellSize) {
  const n = cols * rows;
  const ex = new Float32Array(n);
  const ey = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!domainMask[i] || phi[i] === 0 || !Number.isFinite(phi[i])) continue; // wall, target, or disconnected: e=0
    const col = i % cols;
    const row = (i / cols) | 0;
    const hasW = col > 0 && domainMask[i - 1] && Number.isFinite(phi[i - 1]);
    const hasE = col < cols - 1 && domainMask[i + 1] && Number.isFinite(phi[i + 1]);
    const hasN = row > 0 && domainMask[i - cols] && Number.isFinite(phi[i - cols]);
    const hasS = row < rows - 1 && domainMask[i + cols] && Number.isFinite(phi[i + cols]);

    let dphidx = 0;
    if (hasW && hasE) dphidx = (phi[i + 1] - phi[i - 1]) / (2 * cellSize);
    else if (hasE) dphidx = (phi[i + 1] - phi[i]) / cellSize;
    else if (hasW) dphidx = (phi[i] - phi[i - 1]) / cellSize;

    let dphidy = 0;
    if (hasN && hasS) dphidy = (phi[i + cols] - phi[i - cols]) / (2 * cellSize);
    else if (hasS) dphidy = (phi[i + cols] - phi[i]) / cellSize;
    else if (hasN) dphidy = (phi[i] - phi[i - cols]) / cellSize;

    const g = Math.hypot(dphidx, dphidy);
    if (g > 1e-9) {
      ex[i] = -dphidx / g;
      ey[i] = -dphidy / g;
      continue;
    }
    // Flat neighborhood away from a target — point toward whichever
    // neighbor has the lowest φ (4.5's rule for equal-cost splits).
    let bestPhi = phi[i];
    let bestDx = 0, bestDy = 0;
    if (hasW && phi[i - 1] < bestPhi) { bestPhi = phi[i - 1]; bestDx = -1; bestDy = 0; }
    if (hasE && phi[i + 1] < bestPhi) { bestPhi = phi[i + 1]; bestDx = 1; bestDy = 0; }
    if (hasN && phi[i - cols] < bestPhi) { bestPhi = phi[i - cols]; bestDx = 0; bestDy = -1; }
    if (hasS && phi[i + cols] < bestPhi) { bestPhi = phi[i + cols]; bestDx = 0; bestDy = 1; }
    ex[i] = bestDx;
    ey[i] = bestDy;
  }
  return { ex, ey };
}

const MIN_DOOR_CELLS = 4;
const MAX_DOOR_PATCH_AREA = 200; // m² — a generous safety cap on one door's patch footprint, in real units
const DOOR_BFS_CELL_CAP = 4000; // hard cell-count ceiling, purely so the BFS itself can't run away at a very fine cell size
const SUSTAINABLE_FLUX = 0.6; // people/(m·s) — a conservative fraction of q_max's 1.22 peak, not the peak itself
const DOOR_PATCH_DEPTH_METERS = 1; // how far into the room the patch extends, in real distance — see doorSpreadCells

/**
 * Finds the wall an entrance/exit point is pinned to (the nearest one, by
 * construction — see InputController's `_nearestFixedWallPoint`) and that
 * wall's local thickness there. The point is snapped onto the wall's
 * *boundary* — for a rect/pillar wall that's a face of its solid material,
 * not necessarily its centerline — so "thickness" here means the distance
 * that may still need to be tunnelled through to reach the opposite face.
 */
function nearestWallThickness(point, walls) {
  let best = null;
  let bestDist = Infinity;
  for (const wall of walls) {
    const shape = wall.shape ?? 'line';
    let d;
    let thickness;
    if (shape === 'pillar') {
      d = Math.abs(distance(point, { x: wall.cx, y: wall.cy }) - wall.r);
      thickness = wall.r * 2;
    } else if (shape === 'rect') {
      const b = rectBounds(wall);
      const center = rectCenter(wall);
      const angleRad = ((wall.rotation ?? 0) * Math.PI) / 180;
      const local = rotatePoint(point, center, -angleRad);
      const corners = [
        { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
      ];
      d = Infinity;
      for (let i = 0; i < 4; i++) {
        d = Math.min(d, pointToSegmentDistance(local, corners[i], corners[(i + 1) % 4]));
      }
      // The wall's short dimension is its thickness — a wall used as a
      // perimeter/partition is a thin, elongated block; its long
      // dimension runs *along* the wall, not through it.
      thickness = Math.min(b.w, b.h);
    } else {
      if (!wall.points || wall.points.length < 2) continue;
      d = Infinity;
      for (let i = 0; i < wall.points.length - 1; i++) {
        d = Math.min(d, pointToSegmentDistance(point, wall.points[i], wall.points[i + 1]));
      }
      thickness = wall.thickness ?? 0.1;
    }
    if (d < bestDist) { bestDist = d; thickness = Math.max(thickness, 1e-6); best = thickness; }
  }
  return best; // null if the venue has no walls at all
}

/**
 * A door's own cell plus enough of its walkable neighborhood (breadth-
 * first, so it only ever spreads through open cells — never leaks through
 * a wall) to sustain its actual throughput. Concentrating a whole door's
 * flow into one or two grid cells can demand more flux than that tiny
 * area can physically sustain — a cell's outflow is capped by the
 * fundamental diagram's specific flow, so a high-throughput point-based
 * entrance needs proportionally more spread, the same way a real busy
 * entrance needs to physically be wider than a single door. Sizing: the
 * minimum width capable of sustaining `ratePeopleSec` at `SUSTAINABLE_FLUX`
 * people/m/s, times a fixed real-world depth (`DOOR_PATCH_DEPTH_METERS`) —
 * a stand-in for the multi-cell "door patch" the design doc describes,
 * since the point-based entrance/exit schema doesn't otherwise carry a
 * door width. In a narrow corridor with less open area than that, this
 * naturally stops early and just uses whatever's there (and the sink/
 * source capacity clamps still apply, so it never overflows even if this
 * undersizes the patch).
 *
 * Both dimensions are sized in real units (meters), then converted to a
 * cell count for *this* cellSize — not the other way around. An earlier
 * version used a fixed cell *count* for the depth, which meant the
 * patch's actual real-world footprint shrank as the grid got finer (more,
 * smaller cells for the same depth-in-cells): the same total door
 * throughput was then packed into a physically smaller area, so admission
 * saturated the patch faster and the visible "how fast people get in"
 * behavior depended on cell size, which it must not.
 */
function doorSpreadCells(centerIdx, domainMask, cols, rows, cellSize, ratePeopleSec) {
  const cellArea = cellSize * cellSize;
  const requiredWidth = Math.abs(ratePeopleSec) / SUSTAINABLE_FLUX;
  const widthCells = Math.ceil(requiredWidth / cellSize);
  const depthCells = Math.max(1, Math.round(DOOR_PATCH_DEPTH_METERS / cellSize));
  const maxCellsForArea = Math.ceil(MAX_DOOR_PATCH_AREA / cellArea);
  const targetCells = Math.min(
    DOOR_BFS_CELL_CAP,
    maxCellsForArea,
    Math.max(MIN_DOOR_CELLS, widthCells * depthCells),
  );
  const visited = new Set([centerIdx]);
  const cells = [centerIdx];
  const queue = [centerIdx];
  let head = 0;
  while (cells.length < targetCells && head < queue.length) {
    const idx = queue[head++];
    const col = idx % cols;
    const row = (idx / cols) | 0;
    const neighbors = [];
    if (col > 0) neighbors.push(idx - 1);
    if (col < cols - 1) neighbors.push(idx + 1);
    if (row > 0) neighbors.push(idx - cols);
    if (row < rows - 1) neighbors.push(idx + cols);
    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      if (domainMask[nb]) {
        cells.push(nb);
        queue.push(nb);
        if (cells.length >= targetCells) break;
      }
    }
  }
  return cells;
}

/**
 * Builds the part of the simulation domain shared by every crowd-flow
 * simulator this app ships (the continuum one below, and the agent-based
 * one in density-agents.js): the walkable grid with zones blocked and
 * doors tunnelled through, plus the resulting attraction routing target.
 * Kept in one place so both simulators treat geometry identically rather
 * than maintaining two copies of "zones are obstacles, doors punch
 * through their wall" logic that could quietly drift apart.
 */
export function computeSimulationDomain(venue, cellSize) {
  // margin=0: the mask panel's own debug view wants a little breathing room
  // around the venue, but the simulation must not — masks.js's default
  // 1-unit margin rasterizes a thin ring of "walkable" space just outside
  // the outermost wall (there's no wall there to block it), and once a
  // door is tunnelled fully through its wall (below), that ring becomes
  // reachable too: people admitted through the door end up simulated
  // wandering around *outside* the building in that margin, not just
  // inside it. Dropping the margin to 0 makes the grid end exactly at the
  // venue's own content bounds (which already include the walls'
  // full extent), so there's nothing beyond the outermost wall to leak
  // into at all — the sim's domain is exactly the interior.
  const walkability = computeWalkabilityGrid(venue, cellSize, 0); // domain = W·(1−Bk), see module note above
  const attraction = computeAttractionMask(venue, cellSize, 0);
  // A zone's explicit `walkable` flag (set in the properties panel) says
  // whether people can stand in/on it — not its `type`. Blocking every
  // zone regardless of that flag was wrong: it made a venue's entire GA
  // floor (a "seating" zone, often the largest single area in a venue)
  // unwalkable, leaving the crowd with nowhere to actually stand and
  // making the whole venue read as emptier than it should for a given
  // admitted headcount. Files saved before `walkable` existed fall back to
  // the old type-based default (isZoneWalkable(), schema.js).
  const blockingZones = venue.zones.filter((z) => !isZoneWalkable(z));
  const zoneFootprint = computeZoneFootprintMask({ ...venue, zones: blockingZones }, cellSize, 0);
  const { cols, rows, originX, originY } = walkability;
  const n = cols * rows;
  const domainMask = walkability.grid; // fresh Uint8Array from the call above — safe to mutate, not shared/cached
  const attractingMask = attraction.grid;

  // Zones (stages, restricted areas) are physically occupied — unlike the
  // walkability mask's own "zones never block" convention (docs/MASKS.md,
  // still used as-is by the editor's live overlay and mask debug view), a
  // person can't stand *inside* one. Block them here, specifically for
  // the simulation, before anything else runs.
  for (let i = 0; i < n; i++) {
    if (zoneFootprint.grid[i]) domainMask[i] = 0;
  }

  // An attraction zone is now a blocked obstacle, so its own cells can
  // never be φ=0 targets (solveEikonal only seeds cells that are both in
  // the domain and in the target mask) — using the raw attraction mask as
  // the ingress target would leave every admitted person with nowhere to
  // route to at all. Real crowds don't stand *on* the stage anyway; they
  // gather right up against it. So the actual ingress target is the ring
  // of walkable cells bordering an attraction zone, computed below once
  // the zone blocking above is in place.
  const attractionTargets = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!domainMask[i]) continue;
    const col = i % cols, row = (i / cols) | 0;
    const adjacent = (col > 0 && attractingMask[i - 1])
      || (col < cols - 1 && attractingMask[i + 1])
      || (row > 0 && attractingMask[i - cols])
      || (row < rows - 1 && attractingMask[i + cols]);
    if (adjacent) attractionTargets[i] = 1;
  }

  // An entrance/exit is a doorway — a full gap *through* the wall's
  // material connecting both faces — not a single marked point. But the
  // point itself is only snapped onto the wall's *boundary* (its nearest
  // edge/corner), which for a rect or pillar wall of any real thickness
  // can land on either face — sometimes the outer (exterior) one. Forcing
  // open only that single cell doesn't help if the solid wall material
  // between it and the interior room is still fully blocked: everything
  // admitted through the door then piles up in the thin exterior margin
  // outside the building, never actually entering it. Instead, punch a
  // disk clear through the wall at each door: generous enough (its local
  // thickness, plus a one-cell safety margin) to reach past the opposite
  // face regardless of which side the point landed on.
  for (const pt of venue.points) {
    if (pt.type !== 'entrance' && pt.type !== 'exit') continue;
    const thickness = nearestWallThickness(pt, venue.walls);
    if (thickness == null) continue; // no walls at all — nothing to tunnel through
    const radius = thickness + cellSize;
    const minCol = Math.max(0, Math.floor((pt.x - radius - originX) / cellSize));
    const maxCol = Math.min(cols - 1, Math.ceil((pt.x + radius - originX) / cellSize));
    const minRow = Math.max(0, Math.floor((pt.y - radius - originY) / cellSize));
    const maxRow = Math.min(rows - 1, Math.ceil((pt.y + radius - originY) / cellSize));
    const radiusSq = radius * radius;
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const cx = originX + (col + 0.5) * cellSize;
        const cy = originY + (row + 0.5) * cellSize;
        const dx = cx - pt.x;
        const dy = cy - pt.y;
        if (dx * dx + dy * dy <= radiusSq) domainMask[row * cols + col] = 1;
      }
    }
  }

  return { cols, rows, originX, originY, domainMask, attractingMask, attractionTargets };
}

// --- Main run ---------------------------------------------------------------

/**
 * Runs the density simulation and returns a time series of density
 * snapshots plus a ledger/metrics summary.
 *
 * @param {object} venue
 * @param {number} cellSize world units per cell (shared with the other masks)
 * @param {number} maxPeople total people admitted before ingress ends and
 *   routing switches every remaining occupant toward the exits
 * @param {number} dt seconds per step
 * @param {number} totalTime seconds simulated
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<object>}
 */
export async function runDensitySimulation({
  venue, cellSize, maxPeople, dt, totalTime, onProgress, params = PHYSICS_DEFAULTS,
}) {
  if (!(cellSize > 0)) throw new Error('cellSize must be a positive number.');
  if (!(maxPeople > 0)) throw new Error('Max people must be a positive number.');
  if (!(dt > 0)) throw new Error('Time step must be a positive number.');
  if (!(totalTime > 0)) throw new Error('Total time must be a positive number.');

  const numSteps = Math.min(MAX_SIM_STEPS, Math.ceil(totalTime / dt));
  if (Math.ceil(totalTime / dt) > MAX_SIM_STEPS) {
    throw new Error(`That many steps (${Math.ceil(totalTime / dt).toLocaleString()}) would take too long — raise the time step or lower the total time.`);
  }

  const { cols, rows, originX, originY, domainMask, attractingMask, attractionTargets } = computeSimulationDomain(venue, cellSize);
  const n = cols * rows;
  const entranceExit = computeEntranceExitMask(venue, cellSize, 0);

  // The entrance/exit mask stores each point's `throughput` (people/minute)
  // concentrated at its single nearest cell. Dumping a real door's entire
  // capacity into one grid cell can make that cell saturate to ρ_max
  // almost instantly — a real door has physical width, spanning several
  // cells, not one. Approximate that width by spreading each door's rate
  // over its own cell plus its walkable neighborhood (breadth-first, so
  // it only spreads through the tunnel just punched above and whatever's
  // past it — never through a still-solid wall). The interior room is
  // typically far larger and more open than the thin exterior margin
  // beyond a wall, so a breadth-first fill naturally lands most of a
  // door's patch on the room side even though both are technically
  // reachable — a stand-in for a proper multi-cell "door patch" that the
  // point-based entrance/exit schema doesn't otherwise represent.
  //
  // Entrances and exits are handled differently from here. An exit is a
  // pure per-cell rate (people/m²/s, converted from people/minute) — it
  // can never remove more than what's actually there (4.6: sOut is capped
  // by ρ_c/Δt), so there's no notion of unmet "demand" to track for one.
  // An entrance is different: per 4.6, "demand not admitted because the
  // cell is full goes to a per-patch queue counter Q_i and is offered
  // again next step at the same rate — never dropped, never injected
  // later faster than r." So entrances are kept as door objects (patch +
  // rate + a running queue), not flattened into a per-cell rate grid —
  // see the ingress step below.
  const cellArea = cellSize * cellSize;
  const exitRGrid = new Float32Array(n); // people/m²/s, negative
  const exitMask = new Uint8Array(n);
  const entranceDoors = []; // { cells: number[], ratePerSecond: number, queue: number }
  let hasSource = false;
  let hasExit = false;
  for (let i = 0; i < n; i++) {
    if (entranceExit.grid[i] === 0) continue;
    const ratePerSecond = entranceExit.grid[i] / 60;
    const cellsForDoor = doorSpreadCells(i, domainMask, cols, rows, cellSize, ratePerSecond);
    if (ratePerSecond > 0) {
      entranceDoors.push({ cells: cellsForDoor, ratePerSecond, queue: 0 });
      hasSource = true;
    } else {
      const rate = ratePerSecond / (cellsForDoor.length * cellArea);
      for (const idx of cellsForDoor) { exitRGrid[idx] += rate; exitMask[idx] = 1; }
      hasExit = true;
    }
  }

  const warnings = [];
  if (!hasSource) warnings.push('No entrances in this venue — nobody will enter.');
  if (!hasExit) warnings.push('No exits in this venue — people can enter but never leave.');
  const unsetThroughputCount = venue.points.filter(
    (p) => (p.type === 'entrance' || p.type === 'exit') && (p.throughput === null || p.throughput === undefined),
  ).length;
  if (unsetThroughputCount > 0) {
    warnings.push(`${unsetThroughputCount} entrance/exit point(s) have no throughput set — defaulting to ${DEFAULT_THROUGHPUT} people/minute each, which may not match the real door.`);
  }
  // Per the design doc's consistency rules (4.0), an entrance with nowhere
  // to route to is a layout error, not a silent no-op: with no attracting
  // cell anywhere, φ = ∞ everywhere during ingress, so admitted people
  // never flow anywhere and pile up at the door instead of into the room.
  if (hasSource && !attractingMask.some(Boolean)) {
    warnings.push('No attraction zones — admitted people have nowhere to route to and will jam at the entrance.');
  } else if (hasSource && !attractionTargets.some(Boolean)) {
    // The zone exists but has no adjoining walkable floor at all (e.g. it's
    // fully boxed in by walls) — same practical effect as no zone.
    warnings.push('No walkable floor borders an attraction zone — admitted people have nowhere to route to and will jam at the entrance.');
  }

  // CFL condition for this explicit upwind/MUSCL scheme: a cell's flux
  // can't legitimately drain more than "itself" in one step, which needs
  // dt*|u|/cellSize <= 1 per face (the `2` is `2*vMax` as a conservative
  // bound on |u| across BOTH axes' faces at once, since a diagonal route
  // pushes flux through an east-west face and a north-south face the same
  // step). Violating this doesn't fail loudly — every quantity involved
  // stays finite and in-range — it just makes the explicit update
  // over-correct each step, and the error compounds: a cell overshoots,
  // its neighbor overshoots the other way next step to compensate, and
  // so on, with the SIZE of each overshoot scaling with how much density
  // (and therefore flux) is actually there to move. At low density the
  // resulting error is too small to see; at high density it's large
  // enough to look like the crowd violently oscillating cell to cell
  // ("pulsing") rather than settling — reproduced directly: with this
  // app's own default dt=0.2s/cellSize=0.25m (courant 2.14), a single
  // interior cell was observed swinging 5.4 -> 2.0 -> 5.4 people/m²
  // between consecutive steps once the crowd packed in, a jump an order
  // of magnitude larger than one step's worth of physically possible
  // flow. Rather than rely on the user to pick a dt small enough (and
  // silently misbehave if they don't), the physics update below runs in
  // `subSteps` internal sub-steps of `subDt` each — invisible outside
  // this function (recorded frames, route-recompute cadence, and
  // progress reporting all still happen once per `dt`) — so the scheme
  // is always run within its own stability limit regardless of what dt
  // the UI was given.
  //
  // Target an EFFECTIVE courant of 0.5, not the raw 1.0 upwind bound: a
  // MUSCL/minmod reconstruction is only TVD (guaranteed non-oscillatory)
  // up to about half the plain-upwind CFL limit, since the half-cell
  // reconstruction it adds effectively steepens the scheme's sensitivity
  // to the local wave speed. Measured directly on the same reproduction
  // above: target 1.0 (raw bound) still left a ~0.3 people/m² steady-state
  // ripple next to a jammed area; 0.5 cut that to ~0.19; going tighter
  // still (0.2) only bought a little more (~0.09) for more than double the
  // extra substeps — 0.5 is the better cost/smoothness tradeoff.
  const courant = (dt * 2 * params.vMax) / cellSize;
  const subSteps = Math.max(1, Math.ceil(courant / 0.5));
  const subDt = dt / subSteps;
  if (subSteps > 1) {
    warnings.push(`Δt was too large for this cell size (Courant number ${courant.toFixed(2)}) — automatically ran in ${subSteps} internal sub-steps per recorded frame to stay numerically stable.`);
  }

  // Ping-pong density buffers to avoid allocating a fresh array every step.
  let rho = new Float32Array(n);
  let rhoNext = new Float32Array(n);
  const currentSpeed = new Float32Array(n);
  const routeSpeed = new Float32Array(n);
  const ux = new Float32Array(n); // u = f(ρ)·e, recomputed every step (ρ changes; e only at route recomputes)
  const uy = new Float32Array(n);
  const slopeX = new Float32Array(n); // MUSCL/minmod-limited ρ slopes, recomputed every step — see the transport step below
  const slopeY = new Float32Array(n);
  const netFlux = new Float32Array(n);

  const phase = 'ingress'; // never switches — see the module note further down where it used to
  let phi = null;
  let ex = new Float32Array(n);
  let ey = new Float32Array(n);

  const recomputeRoute = () => {
    for (let i = 0; i < n; i++) routeSpeed[i] = Math.max(speedFn(rho[i], params), params.epsV);
    const targetMask = phase === 'ingress' ? attractionTargets : exitMask;
    phi = solveEikonal(domainMask, targetMask, routeSpeed, cols, rows, cellSize);
    ({ ex, ey } = computeRouteDirection(phi, domainMask, cols, rows, cellSize));
  };
  recomputeRoute();

  const targetFrameCount = 150;
  const recordEvery = Math.max(1, Math.floor(numSteps / targetFrameCount));
  const frames = [rho.slice()];
  const times = [0];

  let nIn = 0, nOut = 0, nClipped = 0;
  let phaseSwitchTime = null;
  let t95 = null;
  const peakDensity = new Float32Array(n);
  let ledgerResidual = 0;

  let lastYield = typeof performance !== 'undefined' ? performance.now() : Date.now();

  for (let step = 1; step <= numSteps; step++) {
    const t = step * dt;

    if (step % params.routeRecomputeEvery === 0) recomputeRoute();

    // The actual finite-volume advance runs `subSteps` times at `subDt`
    // each (subSteps===1, subDt===dt when courant<=1 — no behavior change
    // for a dt that was already stable) so the scheme stays within its
    // CFL limit regardless of the caller's dt; route direction (e) stays
    // frozen across them, same as it already was across whole steps.
    let admittedThisStep = 0;
    let removedThisStep = 0;
    for (let sub = 0; sub < subSteps; sub++) {
      // u = f(ρ)·e (4.2): route direction e is frozen between recomputes,
      // current speed reacts to ρ every sub-step.
      for (let i = 0; i < n; i++) {
        currentSpeed[i] = speedFn(rho[i], params);
        ux[i] = currentSpeed[i] * ex[i];
        uy[i] = currentSpeed[i] * ey[i];
      }

      // Finite-volume MUSCL/minmod update (a second-order refinement of
      // 4.4's first-order upwind scheme — see the module note below). a_cf
      // is the face-normal component of u (averaged from the two cells it
      // joins), not the raw speed magnitude — a diagonal route only pushes
      // its fractional x/y share through each face, the same as a real
      // directional flow, rather than the full speed through every face
      // that merely faces "downhill".
      //
      // Per-cell limited slopes first (needed by both axes' faces below).
      // A cell against a wall/domain edge on either side falls back to a
      // zero slope (plain first-order) there — there's no far-side neighbor
      // to build a meaningful reconstruction from, and this is also exactly
      // where an artificial extremum would be easiest to introduce.
      for (let i = 0; i < n; i++) {
        if (!domainMask[i]) continue;
        const col = i % cols;
        const row = (i / cols) | 0;
        slopeX[i] = (col > 0 && domainMask[i - 1] && col < cols - 1 && domainMask[i + 1])
          ? minmod(rho[i] - rho[i - 1], rho[i + 1] - rho[i])
          : 0;
        slopeY[i] = (row > 0 && domainMask[i - cols] && row < rows - 1 && domainMask[i + cols])
          ? minmod(rho[i] - rho[i - cols], rho[i + cols] - rho[i])
          : 0;
      }

      netFlux.fill(0);
      // East-west faces: reconstruct the upwind cell's density half a cell
      // toward the face (rather than just using its raw cell-center value),
      // using its own limited slope — this is what actually fixes the
      // "front races ahead of the true speed" numerical-diffusion artifact
      // a plain first-order upwind scheme has (worse at a coarser cell
      // size, since the reconstruction error scales with cell width).
      for (let row = 0; row < rows; row++) {
        const rowStart = row * cols;
        for (let col = 0; col < cols - 1; col++) {
          const i = rowStart + col;
          const j = i + 1;
          if (!domainMask[i] || !domainMask[j]) continue; // wall face: zero length, contributes nothing
          const a = 0.5 * (ux[i] + ux[j]); // positive = flow i -> j
          const rhoFace = a >= 0
            ? Math.max(0, rho[i] + 0.5 * slopeX[i])
            : Math.max(0, rho[j] - 0.5 * slopeX[j]);
          const flux = a * rhoFace; // people/(m·s), positive = i -> j
          netFlux[i] += flux;
          netFlux[j] -= flux;
        }
      }
      // North-south faces, same scheme along the other axis.
      for (let row = 0; row < rows - 1; row++) {
        const rowStart = row * cols;
        const nextRowStart = rowStart + cols;
        for (let col = 0; col < cols; col++) {
          const i = rowStart + col;
          const j = nextRowStart + col;
          if (!domainMask[i] || !domainMask[j]) continue;
          const a = 0.5 * (uy[i] + uy[j]);
          const rhoFace = a >= 0
            ? Math.max(0, rho[i] + 0.5 * slopeY[i])
            : Math.max(0, rho[j] - 0.5 * slopeY[j]);
          const flux = a * rhoFace;
          netFlux[i] += flux;
          netFlux[j] -= flux;
        }
      }

      for (let i = 0; i < n; i++) {
        if (!domainMask[i]) { rhoNext[i] = 0; continue; }
        // A_c = cellSize^2, ℓ_f = cellSize for open faces -> ℓ_f/A_c = 1/cellSize
        rhoNext[i] = rho[i] - (subDt / cellSize) * netFlux[i];
      }

      // Sources (capped by maxPeople) and sinks (an exit removes people
      // whenever it's active, throughout the whole run).
      if (nIn + admittedThisStep < maxPeople) {
        // Per-door queue (4.6): each door is only ever offered its own rate
        // in a single sub-step — never faster, even if a backlog has built
        // up and interior capacity has since opened up (that would mean a
        // stalled crowd suddenly rushing a door far faster than its actual
        // capacity, which is exactly what "never faster than r" rules out).
        // What a door's own rate can't place this sub-step (because the
        // cells in its patch are full) stays queued and gets first claim on
        // the next sub-step's placement — so demand is delayed, never
        // dropped.
        for (const door of entranceDoors) {
          const offeredThisSubstep = door.ratePerSecond * subDt;
          door.queue += offeredThisSubstep;
          const toPlace = Math.min(door.queue, offeredThisSubstep);
          let placed = 0;
          for (const idx of door.cells) {
            if (placed >= toPlace) break;
            const capacityPeople = Math.max(0, params.rhoMax - rho[idx]) * cellArea;
            const take = Math.min(toPlace - placed, capacityPeople);
            if (take <= 0) continue;
            rhoNext[idx] += take / cellArea;
            placed += take;
          }
          door.queue -= placed;
          admittedThisStep += placed;
        }
      }
      for (let i = 0; i < n; i++) {
        if (!exitMask[i]) continue;
        const sOut = Math.min(-exitRGrid[i], Math.max(0, rho[i] / subDt));
        rhoNext[i] -= subDt * sOut;
        removedThisStep += sOut * subDt * cellArea;
      }

      // Clamp density to [0, rhoMax], logging clipped mass rather than
      // silently discarding it (4.4). Known consequence, not a bug: a cell
      // clamped to exactly rhoMax has f(rho)=0 exactly (4.3's speed law has
      // no floor for transport — 4.2 explicitly reserves epsV for the route
      // solve only), so it can never emit outflow on its own until an
      // upstream neighbor's density drops first. A short, intense admission
      // burst can pin a few cells at exactly rhoMax right by a busy
      // entrance; they can sit there for a long time even after the rest of
      // the room has drained. Conservation still holds exactly — the ledger
      // (4.7) counts this density as "still inside", not lost — so this
      // shows up as a real, visible hazard (a permanent micro-jam) rather
      // than a silent error.
      for (let i = 0; i < n; i++) {
        if (rhoNext[i] > params.rhoMax) {
          nClipped += (rhoNext[i] - params.rhoMax) * cellArea;
          rhoNext[i] = params.rhoMax;
        } else if (rhoNext[i] < 0) {
          rhoNext[i] = 0;
        }
        if (rhoNext[i] > peakDensity[i]) peakDensity[i] = rhoNext[i];
      }

      // Swap buffers.
      const swap = rho; rho = rhoNext; rhoNext = swap;
    }

    nIn += admittedThisStep;
    nOut += removedThisStep;

    // Admission simply stops once maxPeople is reached (the entranceDoors
    // loop above already gates each door on nIn < maxPeople) — there's no
    // forced mass-evacuation switch afterward. An earlier version
    // retargeted routing to the exits the instant admission hit its cap,
    // which looked like the whole crowd abruptly reversing course for no
    // visible reason; density already inside now just keeps routing
    // toward the attraction as normal, and exits still work exactly as
    // before (the sink loop above runs unconditionally). Without a phase
    // switch there's no defined "evacuation start" moment, so
    // phase/phaseSwitchTime/t95 stay fixed at their initial values.

    let nInside = 0;
    for (let i = 0; i < n; i++) nInside += rho[i];
    nInside *= cellArea;
    ledgerResidual = nIn - nInside - nOut - nClipped;

    if (step % recordEvery === 0 || step === numSteps) {
      frames.push(rho.slice());
      times.push(t);
    }

    if (onProgress && step % 20 === 0) onProgress(step / numSteps);
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastYield > 16) {
      lastYield = now;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (onProgress) onProgress(1);

  return {
    cols, rows, cellSize, originX, originY, unit: venue.meta.unit,
    dt, totalTime, maxPeople,
    frames, times,
    domainMask, // for rendering walls/obstacles as context under the animation
    rhoMax: params.rhoMax,
    phaseSwitchTime,
    ledger: { admitted: nIn, exited: nOut, clipped: nClipped, residual: ledgerResidual },
    metrics: { t95, peakDensity },
    warnings,
  };
}
