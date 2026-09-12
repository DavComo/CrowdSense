import { makeId, ZONE_TYPES, POINT_TYPES, DEFAULT_CONSTRAINTS } from '../model/schema.js';
import { distance, rectBounds, rectCenter, rotatePoint, rotatedRectCorners, normalizeAngleDiff } from './geometry.js';

const MIN_SHAPE_SIZE = 0.15; // world units — below this, a drag is treated as a misclick

/** Drops points that are effectively the same as the one before them (e.g.
 * the second click of a double-click that finishes a polyline). */
function dedupeConsecutive(points) {
  if (!points) return points;
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-6) out.push(p);
  }
  return out;
}

function nearestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function nearestPointOnCircle(p, cx, cy, r) {
  const dx = p.x - cx;
  const dy = p.y - cy;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return { x: cx + r, y: cy }; // p is exactly the center — any direction is as good as another
  return { x: cx + (dx / d) * r, y: cy + (dy / d) * r };
}

/** Nearest point on a (possibly rotated) rect's perimeter — done by
 * rotating into the rect's local unrotated frame, finding the nearest
 * point on its four straight edges there, then rotating that back out. */
function nearestPointOnRectPerimeter(p, rect) {
  const b = rectBounds(rect);
  const center = rectCenter(rect);
  const angleRad = ((rect.rotation ?? 0) * Math.PI) / 180;
  const local = rotatePoint(p, center, -angleRad);
  const corners = [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ];
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < 4; i++) {
    const candidate = nearestPointOnSegment(local, corners[i], corners[(i + 1) % 4]);
    const d = distance(local, candidate);
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  return rotatePoint(best, center, angleRad);
}

/** Nearest point on a wall's boundary, whatever its shape — the point a
 * door snaps onto. Returns null for a degenerate line wall (fewer than 2
 * points). */
function nearestPointOnWall(p, wall) {
  const shape = wall.shape ?? 'line';
  if (shape === 'pillar') return nearestPointOnCircle(p, wall.cx, wall.cy, wall.r);
  if (shape === 'rect') return nearestPointOnRectPerimeter(p, wall);
  if (!wall.points || wall.points.length < 2) return null;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < wall.points.length - 1; i++) {
    const candidate = nearestPointOnSegment(p, wall.points[i], wall.points[i + 1]);
    const d = distance(p, candidate);
    if (d < bestDist) { bestDist = d; best = candidate; }
  }
  return best;
}

/**
 * Translates raw pointer/keyboard events on the canvas into model edits,
 * dispatching on whichever tool is currently active. This is the only place
 * that knows how each tool behaves.
 */
export class InputController {
  constructor(canvas, view, model, hooks) {
    this.canvas = canvas;
    this.view = view;
    this.model = model;
    this.hooks = hooks; // { getTool, setTool, onSelectionChange, setHint, setCoords }

    this._drag = null; // active mousedown->mouseup interaction
    this._spaceHeld = false;
    this._snap = false;

    canvas.addEventListener('mousedown', this._onMouseDown);
    canvas.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    canvas.addEventListener('dblclick', this._onDoubleClick);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this._updateHint();
  }

  get tool() {
    return this.hooks.getTool();
  }

  _localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _snapWorld(p) {
    if (!this._snap) return p;
    const grid = 0.5;
    return { x: Math.round(p.x / grid) * grid, y: Math.round(p.y / grid) * grid };
  }

  /** Pixel-radius snap tolerance, converted to world units at the current zoom. */
  _snapTolerance() {
    return 10 / (this.view.pixelsPerUnit * this.view.zoom);
  }

  /** The vertices of one wall/zone that are valid things for a new point to
   * snap onto — corners for rect, center for circle/pillar, the raw point
   * list otherwise (line walls, polygons, and old walls with no `shape`). */
  _shapePoints(shape) {
    if (shape.shape === 'rect') {
      return rotatedRectCorners(shape); // honors rotation — see geometry.js
    }
    if (shape.shape === 'circle' || shape.shape === 'pillar') {
      return [{ x: shape.cx, y: shape.cy }];
    }
    return shape.points ?? [];
  }

  /** The point a new line segment is being drawn from, if any — the
   * anchor an angle-lock measures against. Only meaningful for tools that
   * draw point-to-point (wall, polygon zone, measure, calibrate). */
  _angleAnchor() {
    if ((this.tool === 'wall' || this.tool === 'poly-zone') && this.view.draft?.points?.length) {
      return this.view.draft.points[this.view.draft.points.length - 1];
    }
    if (this.tool === 'measure' && this._measureStart) return this._measureStart;
    if (this.tool === 'calibrate' && this._calibrateStart) return this._calibrateStart;
    return null;
  }

  /**
   * Nearest 15°-increment direction from `from`, if the raw cursor is close
   * enough to it, measured relative to `referenceRad` — this is the
   * "let it be vertical" behavior: draw roughly horizontal/vertical/45°
   * and it locks exactly onto that angle, at whatever distance you'd
   * actually dragged to.
   *
   * `referenceRad` is 0 (world-horizontal) for a line's first segment, but
   * the *incoming segment's own direction* for every segment after that —
   * so segment 2+ locks onto clean turns (straight ahead, 90° off, etc.)
   * relative to the wall you're already drawing, not to the world grid.
   * Only the very first segment has no previous direction to be relative
   * to, so it's the one that locks to true horizontal/vertical.
   */
  _snapAngle(rawWorld, from, referenceRad = 0) {
    const dx = rawWorld.x - from.x;
    const dy = rawWorld.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return null;

    const stepRad = (15 * Math.PI) / 180;
    const toleranceRad = (4 * Math.PI) / 180;
    const angleRad = Math.atan2(dy, dx);
    const relative = normalizeAngleDiff(angleRad - referenceRad);
    const nearestRelative = Math.round(relative / stepRad) * stepRad;
    if (Math.abs(relative - nearestRelative) > toleranceRad) return null;

    const rad = referenceRad + nearestRelative;
    return { x: from.x + Math.cos(rad) * dist, y: from.y + Math.sin(rad) * dist };
  }

  /**
   * Resolves a raw world-space cursor position to where a click should
   * actually land, checked in priority order:
   *  1. Snap onto a nearby existing wall/zone/point vertex, or a vertex
   *     already placed in the shape currently being drawn (this is what
   *     lets clicking back near a wall's own start point close the loop).
   *     `excludeId` leaves out one item's own vertices — used while
   *     dragging that same item, so it can't snap to its own trailing
   *     position from the previous frame.
   *  2. Lock onto a horizontal/vertical/45°-ish angle from the previous
   *     point in the line currently being drawn.
   *  3. Grid-snap, only if Shift is held.
   *  4. The raw point, unchanged.
   *
   * Whenever there's a line being drawn (an angle anchor exists), this also
   * sets `view.snapAngle` to the segment's *actual* angle — not just when
   * it happens to lock onto a nice 15° increment — so the readout is
   * always on screen while drawing/measuring, not only at snap moments.
   */
  _resolvePoint(rawWorld, excludeId = null) {
    const tolerance = this._snapTolerance();
    let best = null;
    let bestDist = tolerance;
    const consider = (p) => {
      const d = distance(rawWorld, p);
      if (d <= bestDist) { bestDist = d; best = p; }
    };

    for (const wall of this.model.venue.walls) {
      if (wall.id !== excludeId) this._shapePoints(wall).forEach(consider);
    }
    for (const zone of this.model.venue.zones) {
      if (zone.id !== excludeId) this._shapePoints(zone).forEach(consider);
    }
    for (const pt of this.model.venue.points) {
      if (pt.id !== excludeId) consider(pt);
    }
    if (this.view.draft?.points) this.view.draft.points.forEach(consider);

    let result;
    let locked = false;
    if (best) {
      result = { x: best.x, y: best.y };
      this.view.snapTarget = result;
    } else {
      this.view.snapTarget = null;
      const anchor = this._angleAnchor();
      const incoming = this._incomingPoint();
      const referenceRad = incoming ? Math.atan2(anchor.y - incoming.y, anchor.x - incoming.x) : 0;
      const angled = anchor ? this._snapAngle(rawWorld, anchor, referenceRad) : null;
      if (angled) {
        result = angled;
        locked = true;
      } else {
        result = this._snapWorld(rawWorld);
      }
    }

    this.view.snapAngle = this._angleReadout(result, locked);
    return result;
  }

  /** The point before the current anchor in the line being drawn, if any —
   * this is what turns the angle readout into an interior corner angle
   * instead of a bare compass bearing (a lone first segment has nothing
   * before its start point to measure a corner against). */
  _incomingPoint() {
    if ((this.tool === 'wall' || this.tool === 'poly-zone') && this.view.draft?.points?.length >= 2) {
      const pts = this.view.draft.points;
      return pts[pts.length - 2];
    }
    return null;
  }

  /**
   * The live angle readout shown while drawing/measuring, whether or not it
   * happens to be locked to a 15° increment. When there's a previous
   * segment (a real corner, not just the first segment out of the start
   * point), this is the *interior* angle of that corner — between the
   * incoming segment and the one currently being drawn — which is what
   * gets drawn as an arc "inside" the turn. Otherwise it falls back to a
   * plain compass bearing, since a lone ray has no "inside" to speak of.
   */
  _angleReadout(point, locked) {
    const anchor = this._angleAnchor();
    if (!anchor) return null;
    const dx = point.x - anchor.x;
    const dy = point.y - anchor.y;
    if (Math.hypot(dx, dy) < 1e-6) return null;

    const incoming = this._incomingPoint();
    if (incoming) {
      const a1 = Math.atan2(incoming.y - anchor.y, incoming.x - anchor.x);
      const a2 = Math.atan2(dy, dx);
      const diff = normalizeAngleDiff(a2 - a1);
      const degrees = Math.round((Math.abs(diff) * 180) / Math.PI);
      return { from: anchor, incoming, degrees, locked };
    }

    const rawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    // Compass-style 0-359 (0°/90°/180°/270° read as the four cardinal
    // directions; y is down, so 90° is "down").
    const degrees = Math.round(((rawDeg % 360) + 360) % 360);
    return { from: anchor, degrees, locked };
  }

  // --- Event entrypoints -----------------------------------------------

  _onMouseDown = (e) => {
    const screen = this._localPoint(e);
    const rawWorld = this.view.screenToWorld(screen);
    const world = this._resolvePoint(rawWorld);
    const isPanGesture = this.tool === 'pan' || this._spaceHeld || e.button === 1;

    if (isPanGesture) {
      this._drag = { type: 'pan', lastScreen: screen };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    switch (this.tool) {
      case 'select':
        // Hit-testing uses the raw cursor position, not the snapped one —
        // snapping is for placing/moving geometry, not for deciding what a
        // click landed on.
        this._selectMouseDown(rawWorld, screen);
        break;
      case 'wall':
        this._wallMouseDown(world);
        break;
      case 'poly-zone':
        this._polyZoneMouseDown(world);
        break;
      case 'rect-zone':
        this._drag = { type: 'draw-rect', start: world };
        this.view.draft = { kind: 'rect', x: world.x, y: world.y, w: 0, h: 0 };
        break;
      case 'circle-zone':
        this._drag = { type: 'draw-circle', start: world };
        this.view.draft = { kind: 'circle', cx: world.x, cy: world.y, r: 0 };
        break;
      case 'pillar':
        this._drag = { type: 'draw-pillar', start: world };
        this.view.draft = { kind: 'circle', cx: world.x, cy: world.y, r: 0 };
        break;
      case 'wall-rect':
        this._drag = { type: 'draw-wall-rect', start: world };
        this.view.draft = { kind: 'rect', x: world.x, y: world.y, w: 0, h: 0 };
        break;
      case 'point':
        this._placePoint(world);
        break;
      case 'measure':
        this._measureClick(world);
        break;
      case 'calibrate':
        this._calibrateClick(world, screen);
        break;
      default:
        break;
    }
    this.view.render();
  };

  _onMouseMove = (e) => {
    const screen = this._localPoint(e);
    const rawWorld = this.view.screenToWorld(screen);

    if (this._drag?.type === 'pan') {
      this.hooks.setCoords(rawWorld);
      const dx = screen.x - this._drag.lastScreen.x;
      const dy = screen.y - this._drag.lastScreen.y;
      this._drag.lastScreen = screen;
      this.view.pan(dx, dy);
      return;
    }

    if (this._drag) {
      // While moving/resizing an existing item, that item's own vertices
      // don't count as snap targets — otherwise it'd snap to wherever it was
      // one frame ago and feel stuck.
      const excludeId = this._drag.kindId?.id ?? null;
      const world = this._resolvePoint(rawWorld, excludeId);
      this.hooks.setCoords(world);
      this._continueDrag(world);
      this.view.render();
      return;
    }

    // Hover feedback + in-progress previews for click-to-place tools.
    if (this.tool === 'wall' || this.tool === 'poly-zone') {
      const world = this._resolvePoint(rawWorld);
      this.hooks.setCoords(world);
      if (this.view.draft) this.view.draft.cursor = world;
      this.view.render(); // always, so the snap indicator shows even pre-first-click
      return;
    }
    if (this.tool === 'measure' && this._measureStart) {
      const world = this._resolvePoint(rawWorld);
      this.hooks.setCoords(world);
      this.view.measurement = { a: this._measureStart, b: world };
      this.view.render();
      return;
    }
    if (this.tool === 'calibrate' && this._calibrateStart) {
      const world = this._resolvePoint(rawWorld);
      this.hooks.setCoords(world);
      this.view.measurement = { a: this._calibrateStart, b: world };
      this.view.render();
      return;
    }
    if (this.tool === 'select') {
      this.hooks.setCoords(rawWorld);
      this.view.snapTarget = null;
      const handle = this.view.hitTestHandle(rawWorld);
      const hit = handle ? this.view.selection : this.view.hitTest(rawWorld, screen);
      const newHover = hit?.id ?? null;
      if (newHover !== this.view.hoverId) {
        this.view.hoverId = newHover;
        this.view.render();
      }
      if (handle) {
        this.canvas.style.cursor = 'crosshair';
      } else if (hit) {
        const item = this.model.find(`${hit.kind}s`, hit.id);
        this.canvas.style.cursor = item?.movable === false ? 'not-allowed' : 'pointer';
      } else {
        this.canvas.style.cursor = 'default';
      }
      return;
    }
    if (this.tool === 'pan') {
      this.hooks.setCoords(rawWorld);
      return;
    }
    // Remaining placement tools (point, rect-zone, circle-zone, pillar,
    // wall-rect): nothing to draft yet, but show where the next click/drag
    // would snap to.
    const world = this._resolvePoint(rawWorld);
    this.hooks.setCoords(world);
    this.view.render();
  };

  _onMouseUp = () => {
    if (this._drag?.type === 'pan') {
      this._drag = null;
      this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
      return;
    }
    if (this._drag?.type === 'draw-rect') {
      const { x, y, w, h } = this.view.draft;
      this.view.draft = null;
      if (Math.abs(w) >= MIN_SHAPE_SIZE && Math.abs(h) >= MIN_SHAPE_SIZE) {
        this._createZone({ shape: 'rect', x, y, w, h, rotation: 0 });
      }
      this._drag = null;
      this.view.render();
      return;
    }
    if (this._drag?.type === 'draw-circle') {
      const { cx, cy, r } = this.view.draft;
      this.view.draft = null;
      if (r >= MIN_SHAPE_SIZE) this._createZone({ shape: 'circle', cx, cy, r });
      this._drag = null;
      this.view.render();
      return;
    }
    if (this._drag?.type === 'draw-wall-rect') {
      const { x, y, w, h } = this.view.draft;
      this.view.draft = null;
      if (Math.abs(w) >= MIN_SHAPE_SIZE && Math.abs(h) >= MIN_SHAPE_SIZE) {
        this._createWall({ shape: 'rect', x, y, w, h, rotation: 0 });
      }
      this._drag = null;
      this.view.render();
      return;
    }
    if (this._drag?.type === 'draw-pillar') {
      const { cx, cy, r } = this.view.draft;
      this.view.draft = null;
      if (r >= MIN_SHAPE_SIZE) this._createWall({ shape: 'pillar', cx, cy, r });
      this._drag = null;
      this.view.render();
      return;
    }
    if (this._drag && this._drag.type !== 'pan') {
      // Select-tool drags (move / handle) end here. Only push history if the
      // shape actually moved — a plain click-to-select shouldn't clutter undo.
      if (this._drag.moved) {
        // An actual reshape/move, not a plain click — any previously
        // highlighted single node no longer applies.
        this.view.selectedVertex = null;
        this.model.commit();
      } else if (this._drag.type === 'handle') {
        const { type, index } = this._drag.handle;
        if (type === 'wall-vertex' || type === 'polygon-vertex') {
          // A click (not a drag) on a vertex handle selects just that node,
          // so Delete can remove it alone instead of the whole shape.
          this.view.selectedVertex = { ...this._drag.kindId, index };
          this.view.render();
        }
      }
      this._drag = null;
    }
  };

  _onDoubleClick = () => {
    if (this.tool === 'wall') this._finishWall();
    else if (this.tool === 'poly-zone') this._finishPolyZone();
  };

  _onWheel = (e) => {
    e.preventDefault();
    const screen = this._localPoint(e);
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.view.zoomBy(factor, screen);
    this.hooks.onZoomChange?.(this.view.zoom);
  };

  _onKeyDown = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { this._spaceHeld = true; this.canvas.style.cursor = 'grab'; }
    if (e.key === 'Shift') this._snap = true;
    if (e.key === 'Escape') this._cancelDraft();
    if (e.key === 'Enter') {
      if (this.tool === 'wall') this._finishWall();
      if (this.tool === 'poly-zone') this._finishPolyZone();
    }

    const toolKeys = {
      v: 'select', h: 'pan', w: 'wall', r: 'rect-zone', c: 'circle-zone',
      g: 'poly-zone', p: 'point', m: 'measure', i: 'pillar', b: 'wall-rect',
    };
    if (toolKeys[e.key] && !e.metaKey && !e.ctrlKey) {
      this.hooks.setTool(toolKeys[e.key]);
    }
  };

  _onKeyUp = (e) => {
    if (e.code === 'Space') { this._spaceHeld = false; this.canvas.style.cursor = 'default'; }
    if (e.key === 'Shift') this._snap = false;
  };

  onToolChanged() {
    this._cancelDraft();
    this.view.selection = this.tool === 'select' ? this.view.selection : null;
    if (this.tool !== 'select') this.view.selectedVertex = null;
    this.canvas.style.cursor = this.tool === 'pan' ? 'grab' : 'crosshair';
    this._updateHint();
    this.view.render();
  }

  _cancelDraft() {
    this.view.draft = null;
    this._wallDraft = null;
    this._polyDraft = null;
    this._measureStart = null;
    this._calibrateStart = null;
    this.view.measurement = this.tool === 'measure' ? this.view.measurement : null;
    this.view.snapTarget = null;
    this.view.snapAngle = null;
    this.view.render();
  }

  _updateHint() {
    const hints = {
      select: 'Click to select · drag to move · drag a corner to resize, the top handle to rotate (rects only) · click (don\'t drag) a wall/polygon handle then Delete to remove just that node',
      pan: 'Drag to pan the canvas',
      wall: 'Click to add wall points (snaps to nearby geometry; first segment locks to world angles, later ones to 15° off the last wall) · click back on the start to close the loop · double-click or Enter to finish · Esc to cancel',
      'rect-zone': 'Drag to draw a rectangular zone',
      'circle-zone': 'Drag from center to draw a circular zone',
      'poly-zone': 'Click to add points (snaps to nearby geometry; first segment locks to world angles, later ones to 15° off the last one) · click back on the start to close · double-click or Enter to finish',
      pillar: 'Drag from center to draw a pillar (a round obstacle, e.g. a column)',
      'wall-rect': 'Drag to draw a rectangular obstacle (e.g. a block or riser)',
      point: 'Click to place an entrance/exit — snaps onto the nearest fixed (non-movable/extendable) wall',
      measure: 'Click a start point, then an end point to measure real-world distance',
      calibrate: 'Click two points spanning a known real-world distance',
    };
    this.hooks.setHint(hints[this.tool] ?? '');
  }

  // --- Select tool --------------------------------------------------------

  _selectMouseDown(world, screen) {
    // Prefer dragging an existing selection's handle over re-hit-testing.
    const handle = this.view.hitTestHandle(world);
    if (handle) {
      const sel = this.view.selection;
      const item = this.model.find(`${sel.kind}s`, sel.id);
      let linked = [];
      if (handle.type === 'wall-vertex' || handle.type === 'polygon-vertex') {
        linked = this._findCoincidentVertices(item.points[handle.index], sel.kind, sel.id, handle.index);
      } else {
        // Any handle drag other than a vertex changes what's selected, so a
        // previously-selected single node no longer applies.
        this.view.selectedVertex = null;
      }
      // A stable pre-drag snapshot — corner-resize and rotate both need to
      // measure from the shape's state *before* this drag, not the
      // continuously-mutating live item, or they'd drift frame to frame.
      this._drag = { type: 'handle', handle, kindId: sel, linked, original: structuredClone(item) };
      return;
    }

    this.view.selectedVertex = null;
    const hit = this.view.hitTest(world, screen);
    this.view.selection = hit;
    this.hooks.onSelectionChange(hit);

    if (hit) {
      const item = this.model.find(`${hit.kind}s`, hit.id);
      // A designer-locked element (movable: false) still selects — so its
      // properties, including the lock itself, stay reachable — it just
      // can't be dragged.
      if (item?.movable === false) return;
      this._drag = { type: 'move', kindId: hit, start: world, original: structuredClone(item) };
    }
  }

  /** Every OTHER wall/polygon-zone vertex that currently sits at exactly
   * `point` — these are "the same node" in the sense that a new wall drawn
   * from/to an existing vertex (via vertex-snapping) shares its coordinates
   * exactly. Dragging one moves all of them together, so editing one edits
   * the whole connected joint instead of leaving the others behind. */
  _findCoincidentVertices(point, excludeKind, excludeId, excludeIndex) {
    const links = [];
    const scan = (kind, id, points) => {
      points.forEach((p, i) => {
        if (kind === excludeKind && id === excludeId && i === excludeIndex) return;
        if (distance(p, point) < 1e-6) links.push({ kind, id, index: i });
      });
    };
    for (const wall of this.model.venue.walls) {
      if ((wall.shape ?? 'line') === 'line') scan('wall', wall.id, wall.points);
    }
    for (const zone of this.model.venue.zones) {
      if (zone.shape === 'polygon') scan('zone', zone.id, zone.points);
    }
    return links;
  }

  _continueDrag(world) {
    const d = this._drag;
    // Drag-to-size preview: shared by rect-zone/wall-rect (draft.kind 'rect')
    // and circle-zone/pillar (draft.kind 'circle') — they only differ in
    // which collection the shape lands in once the drag ends.
    if (d.type === 'draw-rect' || d.type === 'draw-wall-rect') {
      this.view.draft.w = world.x - d.start.x;
      this.view.draft.h = world.y - d.start.y;
      return;
    }
    if (d.type === 'draw-circle' || d.type === 'draw-pillar') {
      this.view.draft.r = distance(world, d.start);
      return;
    }
    if (d.type === 'move') {
      const dx = world.x - d.start.x;
      const dy = world.y - d.start.y;
      if (dx !== 0 || dy !== 0) d.moved = true;
      const item = this.model.find(`${d.kindId.kind}s`, d.kindId.id);
      if (!item) return;
      this._applyTranslate(item, d.original, d.kindId.kind, dx, dy);
      return;
    }
    if (d.type === 'handle') {
      d.moved = true;
      this._continueHandleDrag(world);
    }
  }

  _applyTranslate(item, original, kind, dx, dy) {
    // Line walls and polygon zones both store their geometry as a point
    // list; a wall's `shape` may be absent (old files predate wall shapes,
    // and always meant "line").
    const isLineWall = kind === 'wall' && (!original.shape || original.shape === 'line');
    if (isLineWall || original.shape === 'polygon') {
      item.points = original.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (original.shape === 'rect') {
      item.x = original.x + dx;
      item.y = original.y + dy;
    } else if (original.shape === 'circle' || original.shape === 'pillar') {
      item.cx = original.cx + dx;
      item.cy = original.cy + dy;
    } else if (kind === 'point') {
      const dragged = { x: original.x + dx, y: original.y + dy };
      const pinned = this._nearestFixedWallPoint(dragged) ?? dragged;
      item.x = pinned.x;
      item.y = pinned.y;
    }
  }

  _continueHandleDrag(world) {
    const sel = this.view.selection;
    const item = this.model.find(`${sel.kind}s`, sel.id);
    if (!item) return;
    const h = this._drag.handle;

    if (h.type === 'wall-vertex' || h.type === 'polygon-vertex') {
      item.points[h.index] = world;
      // Any other vertex that was coincident with this one at drag-start
      // (a shared "node") moves along with it, so the joint stays connected.
      for (const link of this._drag.linked ?? []) {
        const linkedItem = this.model.find(`${link.kind}s`, link.id);
        if (linkedItem?.points?.[link.index]) linkedItem.points[link.index] = world;
      }
    } else if (h.type === 'circle-radius') {
      item.r = Math.max(MIN_SHAPE_SIZE, distance(world, { x: item.cx, y: item.cy }));
    } else if (h.type === 'rect-corner') {
      this._resizeRotatedRect(item, this._drag.original, h.handle, world);
    } else if (h.type === 'rotate') {
      const center = rectCenter(this._drag.original);
      const rawDeg = (Math.atan2(world.y - center.y, world.x - center.x) * 180) / Math.PI;
      // The handle points "up" (screen north) when rotation is 0, and atan2
      // measures "up" as -90°, hence the +90 to align the two.
      let deg = rawDeg + 90;
      if (this._snap) deg = Math.round(deg / 15) * 15; // Shift: snap to 15° increments, same modifier as elsewhere
      item.rotation = ((deg % 360) + 360) % 360;
    }
  }

  /**
   * Resizes a (possibly rotated) rect by dragging one corner, keeping the
   * *opposite* corner fixed in world space and the rotation unchanged.
   * Works by finding where the new center must be (the midpoint between
   * the fixed opposite corner and the cursor), then measuring the cursor's
   * offset from that center in the rect's own unrotated frame to get the
   * new half-width/half-height — the closed-form solution for "resize
   * around a fixed corner without disturbing the existing rotation".
   * Always measures from `original` (the rect's state before this drag
   * began), never the live `item`, so repeated calls across mousemove
   * frames don't compound floating-point drift.
   */
  _resizeRotatedRect(item, original, handle, world) {
    const angleRad = ((original.rotation ?? 0) * Math.PI) / 180;
    const corners = rotatedRectCorners(original); // [nw, ne, se, sw], world space
    const oppositeIndex = { nw: 2, ne: 3, se: 0, sw: 1 }[handle];
    const fixedCorner = corners[oppositeIndex];

    const newCenter = { x: (fixedCorner.x + world.x) / 2, y: (fixedCorner.y + world.y) / 2 };
    const local = rotatePoint(
      { x: world.x - newCenter.x, y: world.y - newCenter.y },
      { x: 0, y: 0 },
      -angleRad,
    );
    const w = Math.max(MIN_SHAPE_SIZE, Math.abs(local.x) * 2);
    const h = Math.max(MIN_SHAPE_SIZE, Math.abs(local.y) * 2);

    item.x = newCenter.x - w / 2;
    item.y = newCenter.y - h / 2;
    item.w = w;
    item.h = h;
    item.rotation = original.rotation ?? 0;
  }

  // --- Wall tool -----------------------------------------------------------

  _wallMouseDown(world) {
    if (!this.view.draft) {
      this.view.draft = { kind: 'polyline', points: [world] };
      return;
    }
    const points = this.view.draft.points;
    // Clicking back on the wall's own start point (already snapped there by
    // _resolvePoint) closes the loop instead of adding a coincident point.
    if (points.length >= 2 && distance(world, points[0]) < 1e-6) {
      points.push({ ...points[0] });
      this._finishWall();
      return;
    }
    points.push(world);
  }

  _finishWall() {
    const draft = this.view.draft;
    const points = dedupeConsecutive(draft?.points);
    if (!points || points.length < 2) { this._cancelDraft(); return; }
    this.model.venue.walls.push({
      id: makeId('wall'),
      shape: 'line',
      points,
      thickness: 0.25,
      color: '#c9cbd4',
      ...DEFAULT_CONSTRAINTS.wall,
    });
    this.model.commit();
    this.view.draft = null;
    this.hooks.setTool('select');
  }

  // --- Pillar / rectangular obstacle tools ----------------------------------
  // Physical obstacles that live in the same `walls` collection as line
  // walls (they're all "things the optimizer must route people around"),
  // distinguished by `shape`.

  _createWall(shapeFields) {
    const wall = {
      id: makeId('wall'),
      color: '#c9cbd4',
      ...DEFAULT_CONSTRAINTS.wall,
      ...shapeFields,
    };
    this.model.venue.walls.push(wall);
    this.model.commit();
    this.view.selection = { kind: 'wall', id: wall.id };
    this.hooks.onSelectionChange(this.view.selection);
    this.hooks.setTool('select');
  }

  // --- Polygon zone tool ----------------------------------------------------

  _polyZoneMouseDown(world) {
    if (!this.view.draft) {
      this.view.draft = { kind: 'polyline', points: [world] };
      return;
    }
    const points = this.view.draft.points;
    // Clicking back on the polygon's own start point closes it — a polygon
    // is already implicitly closed when rendered, so this just finishes it
    // rather than adding a redundant point on top of the first one.
    if (distance(world, points[0]) < 1e-6) {
      // With fewer than 3 points there's no valid polygon to close yet —
      // ignore the click rather than pushing a duplicate of the start,
      // which would otherwise sit in the shape as a zero-area sliver.
      if (points.length >= 3) this._finishPolyZone();
      return;
    }
    points.push(world);
  }

  _finishPolyZone() {
    const draft = this.view.draft;
    const points = dedupeConsecutive(draft?.points);
    if (!points || points.length < 3) { this._cancelDraft(); return; }
    this._createZone({ shape: 'polygon', points });
    this.view.draft = null;
  }

  // --- Zone / point creation -------------------------------------------------

  _createZone(shapeFields) {
    const n = this.model.venue.zones.length + 1;
    const zone = {
      id: makeId('zone'),
      type: 'custom',
      name: `Zone ${n}`,
      color: ZONE_TYPES.custom.color,
      attraction: false, // whether people gravitate here — the attraction mask is binary
      ...shapeFields,
    };
    this.model.venue.zones.push(zone);
    this.model.commit();
    this.view.selection = { kind: 'zone', id: zone.id };
    this.hooks.onSelectionChange(this.view.selection);
    this.hooks.setTool('select');
  }

  /** Places a new entrance/exit point, pinned onto the nearest fixed
   * (non-movable/extendable) wall — a real entrance/exit is an opening in
   * a permanent wall, not a point floating in open floor. Falls back to
   * the raw click position if the venue has no fixed walls at all. */
  _placePoint(world) {
    const n = this.model.venue.points.length + 1;
    const pinned = this._nearestFixedWallPoint(world) ?? world;
    const point = {
      id: makeId('point'),
      type: 'entrance',
      name: `Point ${n}`,
      x: pinned.x,
      y: pinned.y,
      color: POINT_TYPES.entrance.color,
      throughput: null,
    };
    this.model.venue.points.push(point);
    this.model.commit();
    this.view.selection = { kind: 'point', id: point.id };
    this.hooks.onSelectionChange(this.view.selection);
    this.hooks.setTool('select');
  }

  /** The nearest point on the boundary of any FIXED wall (movable: false
   * AND extendable: false — the ones excluded from the barrier mask) to
   * `world`, across every wall shape. Returns null if there are no fixed
   * walls in the venue at all. */
  _nearestFixedWallPoint(world) {
    let best = null;
    let bestDist = Infinity;
    for (const wall of this.model.venue.walls) {
      if (wall.movable !== false || wall.extendable !== false) continue; // not fixed
      const candidate = nearestPointOnWall(world, wall);
      if (!candidate) continue;
      const d = distance(world, candidate);
      if (d < bestDist) { bestDist = d; best = candidate; }
    }
    return best;
  }

  // --- Measure / calibrate --------------------------------------------------

  _measureClick(world) {
    if (!this._measureStart) {
      this._measureStart = world;
      this.view.measurement = { a: world, b: world };
    } else {
      this.view.measurement = { a: this._measureStart, b: world };
      this._measureStart = world; // chain: next click starts a fresh measurement from here
    }
  }

  async _calibrateClick(world) {
    if (!this._calibrateStart) {
      this._calibrateStart = world;
      this.view.measurement = { a: world, b: world };
      return;
    }
    const a = this._calibrateStart;
    const b = world;
    this._calibrateStart = null;
    const pixelDist = distance(this.view.worldToScreen(a), this.view.worldToScreen(b)) / this.view.zoom;
    this.view.measurement = null;

    const unit = this.model.venue.meta.unit;
    const realLength = await this.hooks.promptCalibration(unit);
    if (realLength && realLength > 0) {
      this.model.venue.scale.pixelsPerUnit = pixelDist / realLength;
      this.model.commit();
    }
    this.hooks.setTool('select');
  }
}
