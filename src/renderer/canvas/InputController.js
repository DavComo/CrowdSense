import { makeId, ZONE_TYPES, POINT_TYPES, DEFAULT_CONSTRAINTS } from '../model/schema.js';
import { distance, rectBounds } from './geometry.js';

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

  // --- Event entrypoints -----------------------------------------------

  _onMouseDown = (e) => {
    const screen = this._localPoint(e);
    const world = this._snapWorld(this.view.screenToWorld(screen));
    const isPanGesture = this.tool === 'pan' || this._spaceHeld || e.button === 1;

    if (isPanGesture) {
      this._drag = { type: 'pan', lastScreen: screen };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    switch (this.tool) {
      case 'select':
        this._selectMouseDown(world, screen);
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
    const world = this._snapWorld(this.view.screenToWorld(screen));
    this.hooks.setCoords(world);

    if (this._drag?.type === 'pan') {
      const dx = screen.x - this._drag.lastScreen.x;
      const dy = screen.y - this._drag.lastScreen.y;
      this._drag.lastScreen = screen;
      this.view.pan(dx, dy);
      return;
    }

    if (this._drag) {
      this._continueDrag(world);
      this.view.render();
      return;
    }

    // Hover feedback + in-progress previews for click-to-place tools.
    if (this.tool === 'wall' || this.tool === 'poly-zone') {
      if (this.view.draft) {
        this.view.draft.cursor = world;
        this.view.render();
      }
      return;
    }
    if (this.tool === 'measure' && this._measureStart) {
      this.view.measurement = { a: this._measureStart, b: world };
      this.view.render();
      return;
    }
    if (this.tool === 'calibrate' && this._calibrateStart) {
      this.view.measurement = { a: this._calibrateStart, b: world };
      this.view.render();
      return;
    }
    if (this.tool === 'select') {
      const handle = this.view.hitTestHandle(world);
      const hit = handle ? this.view.selection : this.view.hitTest(world, screen);
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
    }
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
        this._createZone({ shape: 'rect', x, y, w, h });
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
        this._createWall({ shape: 'rect', x, y, w, h });
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
      if (this._drag.moved) this.model.commit();
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
    this.view.render();
  }

  _updateHint() {
    const hints = {
      select: 'Click to select · drag to move · drag a handle to resize',
      pan: 'Drag to pan the canvas',
      wall: 'Click to add wall points · double-click or Enter to finish · Esc to cancel',
      'rect-zone': 'Drag to draw a rectangular zone',
      'circle-zone': 'Drag from center to draw a circular zone',
      'poly-zone': 'Click to add points · double-click or Enter to close the shape',
      pillar: 'Drag from center to draw a pillar (a round obstacle, e.g. a column)',
      'wall-rect': 'Drag to draw a rectangular obstacle (e.g. a block or riser)',
      point: 'Click to place a point marker',
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
      this._drag = { type: 'handle', handle, kindId: this.view.selection };
      return;
    }

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
      item.x = original.x + dx;
      item.y = original.y + dy;
    }
  }

  _continueHandleDrag(world) {
    const sel = this.view.selection;
    const item = this.model.find(`${sel.kind}s`, sel.id);
    if (!item) return;
    const h = this._drag.handle;

    if (h.type === 'wall-vertex') {
      item.points[h.index] = world;
    } else if (h.type === 'polygon-vertex') {
      item.points[h.index] = world;
    } else if (h.type === 'circle-radius') {
      item.r = Math.max(MIN_SHAPE_SIZE, distance(world, { x: item.cx, y: item.cy }));
    } else if (h.type === 'rect-corner') {
      const b = rectBounds(item);
      const opposite = {
        nw: { x: b.x + b.w, y: b.y + b.h },
        ne: { x: b.x, y: b.y + b.h },
        sw: { x: b.x + b.w, y: b.y },
        se: { x: b.x, y: b.y },
      }[h.handle];
      item.x = opposite.x;
      item.y = opposite.y;
      item.w = world.x - opposite.x;
      item.h = world.y - opposite.y;
    }
  }

  // --- Wall tool -----------------------------------------------------------

  _wallMouseDown(world) {
    if (!this.view.draft) this.view.draft = { kind: 'polyline', points: [] };
    this.view.draft.points.push(world);
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
    if (!this.view.draft) this.view.draft = { kind: 'polyline', points: [] };
    this.view.draft.points.push(world);
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
      capacity: null,
      stickiness: null,
      ...DEFAULT_CONSTRAINTS.zone,
      ...shapeFields,
    };
    this.model.venue.zones.push(zone);
    this.model.commit();
    this.view.selection = { kind: 'zone', id: zone.id };
    this.hooks.onSelectionChange(this.view.selection);
    this.hooks.setTool('select');
  }

  _placePoint(world) {
    const n = this.model.venue.points.length + 1;
    const point = {
      id: makeId('point'),
      type: 'entrance',
      name: `Point ${n}`,
      x: world.x,
      y: world.y,
      flowRate: null,
      ...DEFAULT_CONSTRAINTS.point,
    };
    this.model.venue.points.push(point);
    this.model.commit();
    this.view.selection = { kind: 'point', id: point.id };
    this.hooks.onSelectionChange(this.view.selection);
    this.hooks.setTool('select');
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
