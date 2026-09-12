// Computes rasterized grid masks from a venue — walkability, barriers the
// optimizer may adjust, entrance/exit flow rates, and attraction areas.
// All four share the exact same grid-bounds logic for a given (venue,
// cellSize) pair, so any two computed with the same cellSize line up
// cell-for-cell with no extra alignment step — the point of the whole
// exercise, since these feed a shared set of flow equations together.
// Deliberately pure data-in/data-out with no DOM or canvas dependency, so
// this module (or its logic) can be reused straight in simulation code
// without dragging the editor along with it.

import {
  distance,
  pointToSegmentDistance,
  pointInPolygon,
  pointInRotatedRect,
  rectBounds,
  rotatedRectCorners,
} from '../canvas/geometry.js';

export const MAX_GRID_CELLS = 4_000_000; // guard rail against an accidental multi-minute rasterization

/** A point/exit rate with no explicit `throughput` still counts as "open"
 * in the entrance/exit mask, just at this nominal placeholder rate —
 * both density simulators use this exact same fallback as an actual
 * simulation input, not just a "make the mask preview nonzero" value, so
 * it needs to be a plausible single doorway's capacity, not a token
 * amount. ~1 person/second (roughly the design doc's own reference
 * "1.3 people/(m·s)" for a ~1m-wide door) is a reasonable unspecified-
 * door default; the previous value of 1 *per minute* — 60x too slow —
 * made an unset exit act as if almost fully closed, which silently
 * crushed a simulated crowd against it with nowhere to actually go
 * (both simulators also warn when any point is relying on this
 * fallback, so it's never silent). */
export const DEFAULT_THROUGHPUT = 60;

/** Bounding box of everything in the venue, walls/zones/points/background
 * alike — same shape-handling convention used throughout the editor. */
function contentBounds(venue) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  const consider = (x, y) => {
    any = true;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  const considerShape = (s) => {
    if (s.shape === 'rect') {
      // Rotated rect: use its actual (rotated) corners — a tilted rect
      // can reach further than its plain unrotated bounds would suggest.
      for (const c of rotatedRectCorners(s)) consider(c.x, c.y);
    } else if (s.shape === 'circle' || s.shape === 'pillar') {
      consider(s.cx - s.r, s.cy - s.r); consider(s.cx + s.r, s.cy + s.r);
    } else if (s.points) {
      for (const p of s.points) consider(p.x, p.y);
    }
  };
  for (const wall of venue.walls) considerShape(wall);
  for (const zone of venue.zones) considerShape(zone);
  for (const p of venue.points) consider(p.x, p.y);
  if (venue.background) {
    const b = venue.background;
    consider(b.x, b.y); consider(b.x + b.width, b.y + b.height);
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** Shared grid layout for every mask type: same venue + same cellSize
 * always produces the same origin/cols/rows, which is what keeps masks
 * computed separately still aligned. */
function computeGridLayout(venue, cellSize, margin) {
  if (!(cellSize > 0)) throw new Error('cellSize must be a positive number.');
  const bounds = contentBounds(venue);
  if (!bounds) throw new Error('Nothing drawn in this venue yet — nothing to rasterize.');

  const originX = bounds.minX - margin;
  const originY = bounds.minY - margin;
  const width = bounds.maxX - bounds.minX + margin * 2;
  const height = bounds.maxY - bounds.minY + margin * 2;
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));

  if (cols * rows > MAX_GRID_CELLS) {
    throw new Error(
      `That cell size would produce a ${cols}×${rows} grid (${(cols * rows).toLocaleString()} cells) — ` +
      `try a larger cell size.`,
    );
  }
  return { originX, originY, cols, rows };
}

/** Whether a single world point is inside/on a wall obstacle of any shape,
 * with the obstacle's footprint inflated by `cellRadius` (half a cell's
 * diagonal) so a sampled cell center can't miss an obstacle that merely
 * passes through the rest of that cell — without this, a wall thinner
 * than the cell size can leave gaps in an otherwise-solid wall at coarse
 * cell sizes. Trade-off: obstacles read up to ~half a cell thicker than
 * drawn — deliberately erring toward over-blocking over leaving a gap. */
function pointBlockedByWall(point, wall, cellRadius) {
  const shape = wall.shape ?? 'line';
  if (shape === 'pillar') {
    return distance(point, { x: wall.cx, y: wall.cy }) <= wall.r + cellRadius;
  }
  if (shape === 'rect') {
    // Inflate by testing against the (normalized) rect grown by cellRadius
    // on every side, in its own local frame, then let pointInRotatedRect
    // handle the rotation.
    const b = rectBounds(wall);
    const grown = { x: b.x - cellRadius, y: b.y - cellRadius, w: b.w + cellRadius * 2, h: b.h + cellRadius * 2, rotation: wall.rotation };
    return pointInRotatedRect(point, grown);
  }
  // 'line' (or an old wall predating the `shape` field): blocked within
  // half the wall's thickness of any segment.
  const halfThickness = (wall.thickness ?? 0.1) / 2;
  for (let i = 0; i < wall.points.length - 1; i++) {
    if (pointToSegmentDistance(point, wall.points[i], wall.points[i + 1]) <= halfThickness + cellRadius) return true;
  }
  return false;
}

/** Whether a point falls inside a zone's shape (rect/circle/polygon). */
export function pointInZone(point, zone) {
  if (zone.shape === 'rect') {
    return pointInRotatedRect(point, zone);
  }
  if (zone.shape === 'circle') {
    return distance(point, { x: zone.cx, y: zone.cy }) <= zone.r;
  }
  if (zone.shape === 'polygon') {
    return pointInPolygon(point, zone.points);
  }
  return false;
}

function rasterizeWalls(venue, cellSize, margin, wallFilter) {
  const { originX, originY, cols, rows } = computeGridLayout(venue, cellSize, margin);
  const walls = venue.walls.filter((w) => {
    if (!wallFilter(w)) return false;
    const shape = w.shape ?? 'line';
    if (shape === 'pillar' || shape === 'rect') return true;
    return w.points?.length >= 2; // degenerate line walls (a stray single point) aren't worth checking
  });
  const cellRadius = (cellSize * Math.SQRT2) / 2;

  const grid = new Uint8Array(cols * rows);
  let markedCount = 0;
  const point = { x: 0, y: 0 };
  for (let row = 0; row < rows; row++) {
    point.y = originY + (row + 0.5) * cellSize;
    const rowOffset = row * cols;
    for (let col = 0; col < cols; col++) {
      point.x = originX + (col + 0.5) * cellSize;
      for (const wall of walls) {
        if (pointBlockedByWall(point, wall, cellRadius)) {
          grid[rowOffset + col] = 1;
          markedCount++;
          break;
        }
      }
    }
  }
  return { originX, originY, cols, rows, grid, markedCount };
}

/**
 * Walkability mask: 1 = walkable, 0 = blocked by any physical obstacle
 * (any wall, regardless of movable/extendable). Zones never block — see
 * docs/MASKS.md.
 */
export function computeWalkabilityGrid(venue, cellSize, margin = 1) {
  const { originX, originY, cols, rows, grid, markedCount } = rasterizeWalls(venue, cellSize, margin, () => true);
  // Walkability inverts the raw "is an obstacle here" grid: 1 where NOT blocked.
  const walkable = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) walkable[i] = grid[i] ? 0 : 1;
  return {
    type: 'walkability', binary: true,
    cellSize, unit: venue.meta.unit, originX, originY, cols, rows,
    grid: walkable, walkableCount: grid.length - markedCount,
  };
}

/**
 * Barrier mask: 1 = a wall the optimizer is allowed to move/reshape
 * (`movable !== false` or `extendable !== false`) occupies this cell. This
 * is the mask the ML model edits to lower its cost function — fixed/locked
 * walls (`movable: false` AND `extendable: false`) never appear here, even
 * though they still block in the walkability mask.
 */
export function computeBarrierMask(venue, cellSize, margin = 1) {
  const { originX, originY, cols, rows, grid, markedCount } = rasterizeWalls(
    venue, cellSize, margin,
    (w) => w.movable !== false || w.extendable !== false,
  );
  return {
    type: 'barrier', binary: true,
    cellSize, unit: venue.meta.unit, originX, originY, cols, rows,
    grid, barrierCount: markedCount,
  };
}

/**
 * Entrance/exit rate mask: each cell is a signed number, not a flag — 0
 * means no entrance/exit there (or one explicitly set to 0 throughput,
 * i.e. closed), positive means an entrance flowing people in at that many
 * people/minute, negative an exit flowing people out. A point with no
 * `throughput` set still gets a nominal placeholder rate
 * (`DEFAULT_THROUGHPUT`) rather than being invisible — only an explicit
 * `throughput: 0` reads as closed. Every point maps to its single nearest
 * cell; two points landing in the same cell sum.
 */
export function computeEntranceExitMask(venue, cellSize, margin = 1) {
  const { originX, originY, cols, rows } = computeGridLayout(venue, cellSize, margin);
  const grid = new Float64Array(cols * rows);
  let openCount = 0;
  for (const pt of venue.points) {
    const sign = pt.type === 'entrance' ? 1 : pt.type === 'exit' ? -1 : 0;
    if (sign === 0) continue;
    const rate = pt.throughput ?? DEFAULT_THROUGHPUT;
    if (rate === 0) continue; // explicitly closed — leave the cell at 0
    const col = Math.min(cols - 1, Math.max(0, Math.floor((pt.x - originX) / cellSize)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((pt.y - originY) / cellSize)));
    const idx = row * cols + col;
    if (grid[idx] === 0) openCount++;
    grid[idx] += sign * rate;
  }
  return {
    type: 'entrance-exit-rate', binary: false,
    cellSize, unit: venue.meta.unit, originX, originY, cols, rows,
    grid, openCount,
  };
}

/**
 * Attraction mask: 1 = inside a zone with `attraction: true` (people
 * gravitate here), 0 = not. Purely binary, matching the field itself —
 * a zone either draws people or it doesn't; there's no weighted strength.
 */
export function computeAttractionMask(venue, cellSize, margin = 1) {
  const { originX, originY, cols, rows } = computeGridLayout(venue, cellSize, margin);
  const zones = venue.zones.filter((z) => z.attraction === true);
  const grid = new Uint8Array(cols * rows);
  let attractionCount = 0;
  const point = { x: 0, y: 0 };
  for (let row = 0; row < rows; row++) {
    point.y = originY + (row + 0.5) * cellSize;
    const rowOffset = row * cols;
    for (let col = 0; col < cols; col++) {
      point.x = originX + (col + 0.5) * cellSize;
      for (const zone of zones) {
        if (pointInZone(point, zone)) {
          grid[rowOffset + col] = 1;
          attractionCount++;
          break;
        }
      }
    }
  }
  return {
    type: 'attraction', binary: true,
    cellSize, unit: venue.meta.unit, originX, originY, cols, rows,
    grid, attractionCount,
  };
}

/**
 * Every zone's footprint (attraction or not) as a blocking obstacle — 1 =
 * inside some zone. Unlike `computeWalkabilityGrid`, which deliberately
 * treats zones as walkable floor (docs/MASKS.md — that's the convention
 * the editor's own live overlay and mask debug view use, and it stays
 * unchanged here), the density simulator treats a zone as physically
 * occupied: a stage, riser, or restricted area is somewhere a person
 * can't stand, not just a marker. Exported separately, rather than
 * changing `computeWalkabilityGrid` itself, so this one extra consumer
 * doesn't change what every other mask-panel feature has always shown.
 */
export function computeZoneFootprintMask(venue, cellSize, margin = 1) {
  const { originX, originY, cols, rows } = computeGridLayout(venue, cellSize, margin);
  const grid = new Uint8Array(cols * rows);
  const point = { x: 0, y: 0 };
  for (let row = 0; row < rows; row++) {
    point.y = originY + (row + 0.5) * cellSize;
    const rowOffset = row * cols;
    for (let col = 0; col < cols; col++) {
      point.x = originX + (col + 0.5) * cellSize;
      for (const zone of venue.zones) {
        if (pointInZone(point, zone)) { grid[rowOffset + col] = 1; break; }
      }
    }
  }
  return { originX, originY, cols, rows, grid };
}

/** Serializes any computed mask to its exported `*.mask.json` shape. Kept
 * separate from the compute functions so the editor can hold the raw
 * typed array (fast to redraw/reuse) and only pay for the row-array
 * conversion at actual export/debug-view time. */
export function maskToJSON(mask, venueName) {
  const rowsOut = [];
  for (let row = 0; row < mask.rows; row++) {
    const start = row * mask.cols;
    rowsOut.push(Array.from(mask.grid.subarray(start, start + mask.cols)));
  }
  return {
    version: 1,
    type: `crowdsense-${mask.type}-mask`,
    venueName: venueName ?? null,
    unit: mask.unit,
    cellSize: mask.cellSize,
    cols: mask.cols,
    rows: mask.rows,
    origin: { x: mask.originX, y: mask.originY },
    // grid[row][col]. Cell (col,row) covers the world-space rectangle
    // [origin.x + col*cellSize, ... + cellSize) × [origin.y + row*cellSize, ... + cellSize).
    grid: rowsOut,
  };
}
