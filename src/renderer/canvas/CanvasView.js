import { ZONE_TYPES, POINT_TYPES } from '../model/schema.js';
import {
  pointToSegmentDistance,
  pointInPolygon,
  pointInRotatedRect,
  rectBounds,
  rectCenter,
  rotatePoint,
  rotatedRectCorners,
  distance,
  normalizeAngleDiff,
} from './geometry.js';
import { computeWalkabilityGrid } from '../sim/masks.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

/**
 * Owns the <canvas>, the pan/zoom camera, and all drawing. Coordinates in
 * `venue` documents are always in real-world "units" (meters/feet); this
 * class is the only place that converts them to screen pixels.
 */
export class CanvasView {
  constructor(canvas, model) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = model;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    this.layers = {
      background: true,
      grid: true,
      walls: true,
      zones: true,
      points: true,
      walkability: false,
    };
    this.bgOpacity = 0.6;
    this.maskCellSize = 0.25; // world units per cell
    this._walkabilityCache = null; // { key, mask } — recomputed lazily, see _getWalkabilityMask

    this._bgImageCache = { src: null, img: null };

    this.selection = null; // { kind: 'wall'|'zone'|'point', id }
    this.selectedVertex = null; // { kind, id, index } — one node singled out for deletion
    this.hoverId = null;
    this.draft = null; // in-progress shape from the active tool
    this.measurement = null; // { a: {x,y}, b: {x,y} } in world units
    this.snapTarget = null; // { x, y } the cursor is currently snapped onto, if any
    this.snapAngle = null; // { from: {x,y}, degrees } when the in-progress line is angle-locked

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement);
    this.resize();
  }

  get pixelsPerUnit() {
    return this.model.venue.scale.pixelsPerUnit;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;
    this.render();
  }

  // --- Camera ---------------------------------------------------------------

  worldToScreen(p) {
    const s = this.pixelsPerUnit * this.zoom;
    return { x: p.x * s + this.panX, y: p.y * s + this.panY };
  }

  screenToWorld(p) {
    const s = this.pixelsPerUnit * this.zoom;
    return { x: (p.x - this.panX) / s, y: (p.y - this.panY) / s };
  }

  setZoom(newZoom, anchorScreen) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (anchorScreen) {
      const before = this.screenToWorld(anchorScreen);
      this.zoom = clamped;
      const after = this.worldToScreen(before);
      this.panX += anchorScreen.x - after.x;
      this.panY += anchorScreen.y - after.y;
    } else {
      this.zoom = clamped;
    }
    this.render();
  }

  zoomBy(factor, anchorScreen) {
    this.setZoom(this.zoom * factor, anchorScreen);
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    this.render();
  }

  centerView() {
    this.panX = this.viewportWidth / 2;
    this.panY = this.viewportHeight / 2;
    this.zoom = 1;
    this.render();
  }

  fitToContent() {
    const bounds = this._contentBounds();
    if (!bounds) {
      this.centerView();
      return;
    }
    const padding = 60;
    const w = Math.max(bounds.maxX - bounds.minX, 1);
    const h = Math.max(bounds.maxY - bounds.minY, 1);
    const scaleX = (this.viewportWidth - padding * 2) / (w * this.pixelsPerUnit);
    const scaleY = (this.viewportHeight - padding * 2) / (h * this.pixelsPerUnit);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const s = this.pixelsPerUnit * this.zoom;
    this.panX = this.viewportWidth / 2 - cx * s;
    this.panY = this.viewportHeight / 2 - cy * s;
    this.render();
  }

  _contentBounds() {
    const v = this.model.venue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    const consider = (x, y) => {
      any = true;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    const considerShape = (shape) => {
      if (shape.shape === 'rect') {
        // Rotated rect: use its actual (rotated) corners, not the plain
        // unrotated bounds — a tilted rect can reach further than that.
        for (const c of rotatedRectCorners(shape)) consider(c.x, c.y);
      } else if (shape.shape === 'circle' || shape.shape === 'pillar') {
        consider(shape.cx - shape.r, shape.cy - shape.r); consider(shape.cx + shape.r, shape.cy + shape.r);
      } else {
        // 'polygon', 'line', or an old wall with no `shape` at all — all
        // three are point lists.
        for (const p of shape.points) consider(p.x, p.y);
      }
    };
    for (const wall of v.walls) considerShape(wall);
    for (const z of v.zones) considerShape(z);
    for (const p of v.points) consider(p.x, p.y);
    if (v.background) {
      const b = v.background;
      consider(b.x, b.y); consider(b.x + b.width, b.y + b.height);
    }
    return any ? { minX, minY, maxX, maxY } : null;
  }

  // --- Rendering --------------------------------------------------------

  render() {
    const { ctx } = this;
    ctx.save();
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    ctx.fillStyle = '#1a1b1e';
    ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);

    if (this.layers.background) this._drawBackground();
    if (this.layers.grid) this._drawGrid();
    if (this.layers.zones) this._drawZones();
    if (this.layers.walls) this._drawWalls();
    if (this.layers.points) this._drawPoints();
    if (this.layers.walkability) this._drawWalkability();

    this._drawDraft();
    this._drawMeasurement();
    this._drawSnapIndicator();
    ctx.restore();
  }

  _drawBackground() {
    const bg = this.model.venue.background;
    if (!bg) return;
    if (this._bgImageCache.src !== bg.dataUrl) {
      const img = new Image();
      // Data URLs still decode asynchronously — without this, a render that
      // lands before decode finishes would skip the image and nothing would
      // ever trigger a repaint to pick it up.
      img.onload = () => this.render();
      img.src = bg.dataUrl;
      this._bgImageCache = { src: bg.dataUrl, img };
    }
    const img = this._bgImageCache.img;
    if (!img.complete) return;
    const topLeft = this.worldToScreen({ x: bg.x, y: bg.y });
    const size = this.worldToScreen({ x: bg.x + bg.width, y: bg.y + bg.height });
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = this.bgOpacity;
    ctx.drawImage(img, topLeft.x, topLeft.y, size.x - topLeft.x, size.y - topLeft.y);
    ctx.restore();
  }

  _drawGrid() {
    const { ctx } = this;
    const s = this.pixelsPerUnit * this.zoom;
    // Skip drawing every single line when zoomed out far enough that it'd be visual noise.
    let step = 1;
    while (step * s < 18) step *= 5;
    const majorEvery = 5;

    const originScreen = this.worldToScreen({ x: 0, y: 0 });
    const startCol = Math.floor(-originScreen.x / (step * s));
    const endCol = Math.ceil((this.viewportWidth - originScreen.x) / (step * s));
    const startRow = Math.floor(-originScreen.y / (step * s));
    const endRow = Math.ceil((this.viewportHeight - originScreen.y) / (step * s));

    ctx.save();
    ctx.lineWidth = 1;
    for (let col = startCol; col <= endCol; col++) {
      const worldX = col * step;
      const x = originScreen.x + worldX * s;
      const isMajor = Math.round(worldX / step) % majorEvery === 0;
      ctx.strokeStyle = isMajor ? '#3a3b42' : '#2c2d33';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.viewportHeight);
      ctx.stroke();
    }
    for (let row = startRow; row <= endRow; row++) {
      const worldY = row * step;
      const y = originScreen.y + worldY * s;
      const isMajor = Math.round(worldY / step) % majorEvery === 0;
      ctx.strokeStyle = isMajor ? '#3a3b42' : '#2c2d33';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.viewportWidth, y);
      ctx.stroke();
    }

    // Origin crosshair
    ctx.strokeStyle = '#54565f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(originScreen.x - 8, originScreen.y);
    ctx.lineTo(originScreen.x + 8, originScreen.y);
    ctx.moveTo(originScreen.x, originScreen.y - 8);
    ctx.lineTo(originScreen.x, originScreen.y + 8);
    ctx.stroke();
    ctx.restore();
  }

  _drawWalls() {
    for (const wall of this.model.venue.walls) {
      const shape = wall.shape ?? 'line'; // old files predate the `shape` field
      if (shape === 'pillar') this._drawPillar(wall);
      else if (shape === 'rect') this._drawWallRect(wall);
      else this._drawLineWall(wall);
    }
  }

  _drawLineWall(wall) {
    const { ctx } = this;
    if (wall.points.length < 2) return;
    const selected = this.selection?.kind === 'wall' && this.selection.id === wall.id;
    const hovered = this.hoverId === wall.id;
    const locked = wall.movable === false;
    const fixedSize = wall.extendable === false;

    ctx.save();
    ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#c9cbd4' : wall.color || '#c9cbd4';
    ctx.lineWidth = Math.max(2, wall.thickness * this.pixelsPerUnit * this.zoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Dashed = the optimizer isn't allowed to resize/reshape this wall.
    if (fixedSize) ctx.setLineDash([ctx.lineWidth * 1.5, ctx.lineWidth * 0.9]);
    ctx.beginPath();
    wall.points.forEach((p, i) => {
      const sp = this.worldToScreen(p);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    });
    ctx.stroke();
    ctx.restore();

    if (selected && !fixedSize) {
      wall.points.forEach((p, i) => this._drawHandle(this.worldToScreen(p), this._isVertexSelected('wall', wall.id, i)));
    }
    if (locked) this._drawLockBadge(this._wallMidpoint(wall));
  }

  /** Whether a specific vertex is the one singled out for delete (set by
   * clicking, not dragging, a vertex handle in the select tool). */
  _isVertexSelected(kind, id, index) {
    const sv = this.selectedVertex;
    return Boolean(sv && sv.kind === kind && sv.id === id && sv.index === index);
  }

  /** A round obstacle — a support column, etc. Solid fill: unlike a zone,
   * this is a physical thing people can't walk through. */
  _drawPillar(wall) {
    const { ctx } = this;
    const selected = this.selection?.kind === 'wall' && this.selection.id === wall.id;
    const hovered = this.hoverId === wall.id;
    const locked = wall.movable === false;
    const fixedSize = wall.extendable === false;
    const color = wall.color || '#c9cbd4';
    const c = this.worldToScreen({ x: wall.cx, y: wall.cy });
    const r = wall.r * this.pixelsPerUnit * this.zoom;

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#ffffff' : hexToRgba(color, 0.6);
    ctx.lineWidth = selected ? 2.5 : 1.5;
    if (fixedSize) ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (selected && !fixedSize) this._drawHandle({ x: c.x + r, y: c.y });
    if (locked) this._drawLockBadge(c);
  }

  /** A rectangular obstacle — a block, riser, bar counter, etc. */
  _drawWallRect(wall) {
    const { ctx } = this;
    const selected = this.selection?.kind === 'wall' && this.selection.id === wall.id;
    const hovered = this.hoverId === wall.id;
    const locked = wall.movable === false;
    const fixedSize = wall.extendable === false;
    const color = wall.color || '#c9cbd4';
    const corners = rotatedRectCorners(wall).map((p) => this.worldToScreen(p));

    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#ffffff' : hexToRgba(color, 0.6);
    ctx.lineWidth = selected ? 2.5 : 1.5;
    if (fixedSize) ctx.setLineDash([5, 3]);
    ctx.beginPath();
    corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (selected && !fixedSize) {
      corners.forEach((p) => this._drawHandle(p));
      this._drawRotateHandle(wall);
    }
    if (locked) {
      const cx = corners.reduce((s, p) => s + p.x, 0) / 4;
      const cy = corners.reduce((s, p) => s + p.y, 0) / 4;
      this._drawLockBadge({ x: cx, y: cy });
    }
  }

  /** World-space positions for a rotated rect's rotate handle and the
   * top-center point it's tethered to — shared by rendering and
   * hit-testing so the clickable spot is exactly where it's drawn. */
  _rotateHandleGeometry(rect) {
    const center = rectCenter(rect);
    const b = rectBounds(rect);
    const angleRad = ((rect.rotation ?? 0) * Math.PI) / 180;
    const offset = Math.max(0.4, b.h * 0.15);
    return {
      topCenter: rotatePoint({ x: center.x, y: b.y }, center, angleRad),
      handle: rotatePoint({ x: center.x, y: b.y - offset }, center, angleRad),
    };
  }

  _drawRotateHandle(rect) {
    const { topCenter, handle } = this._rotateHandleGeometry(rect);
    const topSp = this.worldToScreen(topCenter);
    const handleSp = this.worldToScreen(handle);
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = '#2a6bd6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(topSp.x, topSp.y);
    ctx.lineTo(handleSp.x, handleSp.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(handleSp.x, handleSp.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  _wallMidpoint(wall) {
    const mid = Math.floor((wall.points.length - 1) / 2);
    const a = wall.points[mid];
    const b = wall.points[mid + 1] ?? a;
    return this.worldToScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }

  _drawZones() {
    const { ctx } = this;
    for (const zone of this.model.venue.zones) {
      const def = ZONE_TYPES[zone.type] ?? ZONE_TYPES.custom;
      const color = zone.color || def.color;
      const selected = this.selection?.kind === 'zone' && this.selection.id === zone.id;
      const hovered = this.hoverId === zone.id;
      const locked = zone.movable === false;
      const fixedSize = zone.extendable === false;

      ctx.save();
      ctx.fillStyle = hexToRgba(color, 0.28);
      ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#ffffff' : color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      // Dashed = the optimizer isn't allowed to resize/reshape this zone —
      // same convention as a fixed-size wall.
      if (fixedSize) ctx.setLineDash([5, 3]);

      if (zone.shape === 'rect') {
        const corners = rotatedRectCorners(zone).map((p) => this.worldToScreen(p));
        ctx.beginPath();
        corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (selected && !fixedSize) {
          corners.forEach((p) => this._drawHandle(p));
          this._drawRotateHandle(zone);
        }
      } else if (zone.shape === 'circle') {
        const c = this.worldToScreen({ x: zone.cx, y: zone.cy });
        const r = zone.r * this.pixelsPerUnit * this.zoom;
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (selected && !fixedSize) this._drawHandle({ x: c.x + r, y: c.y });
      } else if (zone.shape === 'polygon' && zone.points.length >= 2) {
        ctx.beginPath();
        zone.points.forEach((p, i) => {
          const sp = this.worldToScreen(p);
          if (i === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (selected && !fixedSize) {
          zone.points.forEach((p, i) => this._drawHandle(this.worldToScreen(p), this._isVertexSelected('zone', zone.id, i)));
        }
      }

      // Label
      const labelPos = this._zoneLabelAnchor(zone);
      if (labelPos) {
        ctx.fillStyle = '#f0f0f2';
        ctx.font = '600 12px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 4;
        ctx.fillText(zone.name || def.label, labelPos.x, labelPos.y);
      }
      ctx.restore();
      // Offset below the name label (drawn at the same anchor) rather than
      // on top of it.
      if (locked && labelPos) this._drawLockBadge({ x: labelPos.x, y: labelPos.y + 16 });
    }
  }

  _zoneLabelAnchor(zone) {
    if (zone.shape === 'rect') {
      const b = rectBounds(zone);
      return this.worldToScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    }
    if (zone.shape === 'circle') return this.worldToScreen({ x: zone.cx, y: zone.cy });
    if (zone.shape === 'polygon' && zone.points.length) {
      const cx = zone.points.reduce((s, p) => s + p.x, 0) / zone.points.length;
      const cy = zone.points.reduce((s, p) => s + p.y, 0) / zone.points.length;
      return this.worldToScreen({ x: cx, y: cy });
    }
    return null;
  }

  _drawPoints() {
    const { ctx } = this;
    for (const pt of this.model.venue.points) {
      const def = POINT_TYPES[pt.type] ?? POINT_TYPES.entrance;
      const color = pt.color || def.color;
      const selected = this.selection?.kind === 'point' && this.selection.id === pt.id;
      const hovered = this.hoverId === pt.id;
      const sp = this.worldToScreen(pt);
      const radius = 9;

      ctx.save();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = selected ? '#ffffff' : hovered ? '#ffffff' : 'rgba(0,0,0,0.4)';
      ctx.lineWidth = selected ? 3 : 1.5;
      ctx.stroke();

      ctx.fillStyle = '#111114';
      ctx.font = '700 9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.glyph, sp.x, sp.y + 0.5);

      ctx.fillStyle = '#f0f0f2';
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 4;
      ctx.fillText(pt.name || def.label, sp.x + radius + 5, sp.y);
      ctx.restore();
    }
  }

  /** Recomputes the walkability grid only when the cell size or the wall
   * layout actually changed since last time — this runs on every render()
   * while the layer is visible, so it's worth not re-rasterizing for free. */
  _getWalkabilityMask() {
    const key = `${this.maskCellSize}:${JSON.stringify(this.model.venue.walls)}`;
    if (this._walkabilityCache?.key === key) return this._walkabilityCache.mask;
    let mask = null;
    try {
      mask = computeWalkabilityGrid(this.model.venue, this.maskCellSize);
    } catch {
      // Nothing drawn yet, or the cell size would blow up the grid size —
      // the overlay just doesn't draw; the export action surfaces this
      // properly since that's a deliberate, one-off user action.
    }
    this._walkabilityCache = { key, mask, offscreen: null };
    return mask;
  }

  _drawWalkability() {
    const mask = this._getWalkabilityMask();
    if (!mask) return;

    if (!this._walkabilityCache.offscreen) {
      const off = document.createElement('canvas');
      off.width = mask.cols;
      off.height = mask.rows;
      const octx = off.getContext('2d');
      const imageData = octx.createImageData(mask.cols, mask.rows);
      for (let i = 0; i < mask.grid.length; i++) {
        const o = i * 4;
        if (mask.grid[i] === 0) {
          // Blocked — translucent red.
          imageData.data[o] = 224; imageData.data[o + 1] = 86; imageData.data[o + 2] = 79; imageData.data[o + 3] = 140;
        } else {
          imageData.data[o + 3] = 0; // walkable — fully transparent, draw nothing over it
        }
      }
      octx.putImageData(imageData, 0, 0);
      this._walkabilityCache.offscreen = off;
    }

    const { ctx } = this;
    const tl = this.worldToScreen({ x: mask.originX, y: mask.originY });
    const br = this.worldToScreen({
      x: mask.originX + mask.cols * mask.cellSize,
      y: mask.originY + mask.rows * mask.cellSize,
    });
    ctx.save();
    ctx.imageSmoothingEnabled = false; // keep the grid crisp/blocky, not blurred
    ctx.drawImage(this._walkabilityCache.offscreen, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.restore();
  }

  _drawHandle(sp, selected = false) {
    const { ctx } = this;
    ctx.save();
    // Selected (click, not dragged) = the node Delete will remove alone.
    ctx.fillStyle = selected ? '#e0564f' : '#ffffff';
    ctx.strokeStyle = selected ? '#ffffff' : '#2a6bd6';
    ctx.lineWidth = 1.5;
    const size = selected ? 5 : 4;
    ctx.beginPath();
    ctx.rect(sp.x - size, sp.y - size, size * 2, size * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Small "the optimizer can't move this" marker, used where there's no
   * label to prepend a lock glyph to (walls have none). */
  _drawLockBadge(sp) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = 'rgba(20,20,22,0.85)';
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🔒', sp.x, sp.y + 0.5);
    ctx.restore();
  }

  /** Shows the current segment's angle — always, not only when it's locked
   * to a 15° increment (highlighted teal when it is, plain otherwise). Once
   * there's a previous segment to turn from, this is an interior-angle arc
   * "inside" the corner rather than a bare compass bearing, since that's
   * the number that actually matters for a room's shape (is this corner a
   * clean 90°?). */
  _drawAngleLabel(worldCursor) {
    if (!this.snapAngle) return;
    const { degrees, locked, from, incoming } = this.snapAngle;
    const color = locked ? '#4fe0c9' : '#c9cbd4';
    if (incoming) {
      this._drawInteriorAngle(from, incoming, worldCursor, degrees, color);
    } else {
      this._drawBearingLabel(worldCursor, degrees, color);
    }
  }

  _drawBearingLabel(worldCursor, degrees, color) {
    const { ctx } = this;
    const sp = this.worldToScreen(worldCursor);
    const label = `${degrees}°`;
    ctx.save();
    ctx.font = '700 11px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(20,20,22,0.85)';
    ctx.fillRect(sp.x + 12, sp.y - 10, textWidth + 12, 20);
    ctx.fillStyle = color;
    ctx.fillText(label, sp.x + 18, sp.y);
    ctx.restore();
  }

  /** The protractor-style arc at a corner, swept through the shorter
   * (interior) angle between the incoming segment and the one being drawn,
   * with the degree label sitting just outside its midpoint. */
  _drawInteriorAngle(vertexWorld, incomingWorld, cursorWorld, degrees, color) {
    const { ctx } = this;
    const v = this.worldToScreen(vertexWorld);
    const pIncoming = this.worldToScreen(incomingWorld);
    const pCursor = this.worldToScreen(cursorWorld);
    const a1 = Math.atan2(pIncoming.y - v.y, pIncoming.x - v.x);
    const a2 = Math.atan2(pCursor.y - v.y, pCursor.x - v.x);
    const diff = normalizeAngleDiff(a2 - a1);
    if (Math.abs(diff) < 1e-6) return; // segments coincide — nothing to arc

    const radius = 24;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(v.x, v.y, radius, a1, a1 + diff, diff < 0);
    ctx.stroke();
    ctx.restore();

    const mid = a1 + diff / 2;
    const labelPos = { x: v.x + Math.cos(mid) * (radius + 14), y: v.y + Math.sin(mid) * (radius + 14) };
    const label = `${degrees}°`;
    ctx.save();
    ctx.font = '700 11px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(20,20,22,0.85)';
    ctx.fillRect(labelPos.x - textWidth / 2 - 6, labelPos.y - 10, textWidth + 12, 20);
    ctx.fillStyle = color;
    ctx.fillText(label, labelPos.x, labelPos.y);
    ctx.restore();
  }

  _drawDraft() {
    if (!this.draft) return;
    const { ctx } = this;
    const angleLocked = Boolean(this.snapAngle?.locked);
    ctx.save();
    ctx.strokeStyle = angleLocked ? '#4fe0c9' : '#4f8fd6';
    ctx.fillStyle = angleLocked ? 'rgba(79, 224, 201, 0.2)' : 'rgba(79, 143, 214, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    const d = this.draft;
    if (d.kind === 'polyline' && d.points.length) {
      ctx.beginPath();
      d.points.forEach((p, i) => {
        const sp = this.worldToScreen(p);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      if (d.cursor) {
        const sp = this.worldToScreen(d.cursor);
        ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      for (const p of d.points) this._drawHandle(this.worldToScreen(p));
      if (this.snapAngle && d.cursor) this._drawAngleLabel(d.cursor);
    } else if (d.kind === 'rect') {
      const tl = this.worldToScreen({ x: d.x, y: d.y });
      const br = this.worldToScreen({ x: d.x + d.w, y: d.y + d.h });
      ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    } else if (d.kind === 'circle') {
      const c = this.worldToScreen({ x: d.cx, y: d.cy });
      const r = d.r * this.pixelsPerUnit * this.zoom;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawMeasurement() {
    if (!this.measurement) return;
    const { a, b } = this.measurement;
    const sa = this.worldToScreen(a);
    const sb = this.worldToScreen(b);
    const { ctx } = this;
    const unit = this.model.venue.meta.unit;
    const realDist = distance(a, b);

    ctx.save();
    ctx.strokeStyle = '#f2c94c';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const p of [sa, sb]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#f2c94c';
      ctx.fill();
    }

    const mid = { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 };
    const label = this.snapAngle
      ? `${realDist.toFixed(2)} ${unit} · ${this.snapAngle.degrees}°`
      : `${realDist.toFixed(2)} ${unit}`;
    ctx.font = '700 13px -apple-system, sans-serif';
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(20,20,22,0.85)';
    ctx.fillRect(mid.x - textWidth / 2 - 8, mid.y - 22, textWidth + 16, 22);
    ctx.fillStyle = '#f2c94c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mid.x, mid.y - 11);
    ctx.restore();
  }

  /** A ring around whatever vertex the cursor is currently snapped onto —
   * makes the otherwise-invisible snapping in InputController visible. */
  _drawSnapIndicator() {
    if (!this.snapTarget) return;
    const { ctx } = this;
    const p = this.worldToScreen(this.snapTarget);
    ctx.save();
    ctx.strokeStyle = '#4fe0c9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // --- Hit testing ------------------------------------------------------

  /** Returns { kind, id } for the top-most item under a world point, or null. */
  hitTest(worldPoint, screenPoint) {
    const s = this.pixelsPerUnit * this.zoom;
    const tolerance = 8 / s; // ~8 screen px, in world units

    // Checked in the same order they're drawn on top of each other (points
    // over walls/obstacles over zones), so whatever's visually on top is
    // also what a click there selects.
    if (this.layers.points) {
      const pts = this.model.venue.points;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (distance(worldPoint, pts[i]) <= 10 / s) return { kind: 'point', id: pts[i].id };
      }
    }

    if (this.layers.walls) {
      const walls = this.model.venue.walls;
      for (let i = walls.length - 1; i >= 0; i--) {
        const w = walls[i];
        const shape = w.shape ?? 'line';
        if (shape === 'pillar') {
          if (distance(worldPoint, { x: w.cx, y: w.cy }) <= w.r) return { kind: 'wall', id: w.id };
        } else if (shape === 'rect') {
          if (pointInRotatedRect(worldPoint, w)) return { kind: 'wall', id: w.id };
        } else {
          for (let j = 0; j < w.points.length - 1; j++) {
            if (pointToSegmentDistance(worldPoint, w.points[j], w.points[j + 1]) <= tolerance + w.thickness / 2) {
              return { kind: 'wall', id: w.id };
            }
          }
        }
      }
    }

    if (this.layers.zones) {
      const zones = this.model.venue.zones;
      for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        if (z.shape === 'rect') {
          if (pointInRotatedRect(worldPoint, z)) return { kind: 'zone', id: z.id };
        } else if (z.shape === 'circle') {
          if (distance(worldPoint, { x: z.cx, y: z.cy }) <= z.r) return { kind: 'zone', id: z.id };
        } else if (z.shape === 'polygon' && z.points.length >= 3) {
          if (pointInPolygon(worldPoint, z.points)) return { kind: 'zone', id: z.id };
        }
      }
    }

    return null;
  }

  /** Finds a draggable vertex handle near a world point for the selected shape. */
  hitTestHandle(worldPoint) {
    if (!this.selection) return null;
    const s = this.pixelsPerUnit * this.zoom;
    const tol = 8 / s;
    const { kind, id } = this.selection;

    if (kind === 'wall') {
      const wall = this.model.find('walls', id);
      if (!wall || wall.extendable === false) return null;
      const shape = wall.shape ?? 'line';
      if (shape === 'pillar') {
        const edge = { x: wall.cx + wall.r, y: wall.cy };
        if (distance(worldPoint, edge) <= tol) return { type: 'circle-radius' };
      } else if (shape === 'rect') {
        return this._rectHandleAt(wall, worldPoint, tol);
      } else {
        for (let i = 0; i < wall.points.length; i++) {
          if (distance(worldPoint, wall.points[i]) <= tol) return { type: 'wall-vertex', index: i };
        }
      }
    } else if (kind === 'zone') {
      const zone = this.model.find('zones', id);
      if (!zone || zone.extendable === false) return null;
      if (zone.shape === 'rect') {
        return this._rectHandleAt(zone, worldPoint, tol);
      } else if (zone.shape === 'circle') {
        const edge = { x: zone.cx + zone.r, y: zone.cy };
        if (distance(worldPoint, edge) <= tol) return { type: 'circle-radius' };
      } else if (zone.shape === 'polygon') {
        for (let i = 0; i < zone.points.length; i++) {
          if (distance(worldPoint, zone.points[i]) <= tol) return { type: 'polygon-vertex', index: i };
        }
      }
    }
    return null;
  }

  /** Corner-resize or rotate handle at a world point, for a (possibly
   * rotated) rect — shared between wall-blocks and rect zones. Checks the
   * rotate handle first since it sits further out from the shape than the
   * corners do, so there's no overlap to worry about. */
  _rectHandleAt(rect, worldPoint, tol) {
    const { handle } = this._rotateHandleGeometry(rect);
    if (distance(worldPoint, handle) <= tol) return { type: 'rotate' };
    const corners = rotatedRectCorners(rect);
    const labels = ['nw', 'ne', 'se', 'sw'];
    for (let i = 0; i < 4; i++) {
      if (distance(worldPoint, corners[i]) <= tol) return { type: 'rect-corner', handle: labels[i] };
    }
    return null;
  }
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
