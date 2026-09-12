// Playback window for a finished density simulation — renders each
// recorded density frame as a heatmap (dark-to-hot colormap), with a
// STATIC designer-view overlay drawn on top: the venue's actual walls,
// zones, and entrance/exit points, in the same style the editor itself
// draws them — instead of the density canvas's own crude "wall/obstacle
// = solid dark cell" rendering. The overlay is drawn once per render()
// (the venue's geometry doesn't change frame to frame), not per frame.
//
// Also supports a "compare" mode (payload.compare = { before, after }),
// used by the optimizer's "Compare Density Side-by-Side…" button: the
// same two panes play back in lockstep (both runs share dt/totalTime, so
// their frame counts always match) against one shared colormap scale, so
// colors are directly comparable between the original and optimized
// layouts rather than each being scaled to its own peak — each pane gets
// its own designer overlay, since the optimizer may have moved/removed
// elements between the "before" and "after" venues.

import { rectBounds, rotatedRectCorners } from './canvas/geometry.js';
import { ZONE_TYPES, POINT_TYPES } from './model/schema.js';

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const warningsEl = document.getElementById('warnings');
const emptyStateEl = document.getElementById('empty-state');
const singleFrameEl = document.getElementById('single-frame');
const canvas = document.getElementById('density-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const compareWrapEl = document.getElementById('compare-wrap');
const canvasBefore = document.getElementById('density-canvas-before');
const canvasAfter = document.getElementById('density-canvas-after');
const overlayCanvasBefore = document.getElementById('overlay-canvas-before');
const overlayCanvasAfter = document.getElementById('overlay-canvas-after');
const controlsEl = document.getElementById('controls');
const playBtn = document.getElementById('play-btn');
const scrub = document.getElementById('scrub');
const timeReadoutEl = document.getElementById('time-readout');
const legendMaxEl = document.getElementById('legend-max');
const hoverInfoEl = document.getElementById('hover-info');
const canvasWrap = document.getElementById('canvas-wrap');
const ctx = canvas.getContext('2d');
const ctxBefore = canvasBefore.getContext('2d');
const ctxAfter = canvasAfter.getContext('2d');

let mode = 'single'; // 'single' | 'compare'
let current = null; // single-mode payload (with .displayMax attached)
let cmpBefore = null; // compare-mode payloads (each with .displayMax attached)
let cmpAfter = null;
let frameIdx = 0;
let playing = false;
let playTimer = null;

function frameCount() {
  if (mode === 'compare') return cmpBefore ? cmpBefore.frames.length : 0;
  return current ? current.frames.length : 0;
}
function totalTimeOf() {
  return mode === 'compare' ? cmpBefore.totalTime : current.totalTime;
}

function hexToRgba(hex, alpha) {
  const clean = (hex || '#c9cbd4').replace('#', '');
  const bigint = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Draws the venue exactly the way the editor's own canvas would — walls,
 * zones (translucent fill + outline + label), entrance/exit points (glyph
 * + label) — onto an overlay canvas stacked pixel-for-pixel on top of a
 * density-playback canvas. `overlayCanvas.width/height` (its actual pixel
 * buffer, set in fitCanvasToContainer) is assumed already sized to the
 * CSS box; `payload` supplies the world<->grid mapping (originX/originY,
 * cellSize, cols) the density frames themselves use, so a wall drawn here
 * lines up exactly with the "wall" cells in the density data beneath it. */
function drawDesignerOverlay(canvasEl, venue, payload) {
  const octx = canvasEl.getContext('2d');
  octx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  if (!venue) return;
  const pxPerCell = canvasEl.width / payload.cols;
  const scale = pxPerCell / payload.cellSize; // CSS/device px per world unit
  const toScreen = (p) => ({ x: (p.x - payload.originX) * scale, y: (p.y - payload.originY) * scale });

  for (const wall of venue.walls || []) {
    const shape = wall.shape ?? 'line';
    const color = wall.color || '#c9cbd4';
    octx.save();
    if (shape === 'pillar') {
      const c = toScreen({ x: wall.cx, y: wall.cy });
      octx.fillStyle = color;
      octx.strokeStyle = hexToRgba(color, 0.6);
      octx.lineWidth = 1;
      octx.beginPath();
      octx.arc(c.x, c.y, Math.max(1, wall.r * scale), 0, Math.PI * 2);
      octx.fill(); octx.stroke();
    } else if (shape === 'rect') {
      const corners = rotatedRectCorners(wall).map(toScreen);
      octx.fillStyle = color;
      octx.strokeStyle = hexToRgba(color, 0.6);
      octx.lineWidth = 1;
      octx.beginPath();
      corners.forEach((p, i) => (i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y)));
      octx.closePath(); octx.fill(); octx.stroke();
    } else {
      const pts = (wall.points || []).map(toScreen);
      if (pts.length >= 2) {
        octx.strokeStyle = color;
        octx.lineWidth = Math.max(1, (wall.thickness ?? 0.25) * scale);
        octx.lineCap = 'round'; octx.lineJoin = 'round';
        octx.beginPath();
        pts.forEach((p, i) => (i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y)));
        octx.stroke();
      }
    }
    octx.restore();
  }

  for (const zone of venue.zones || []) {
    const def = ZONE_TYPES[zone.type] ?? ZONE_TYPES.custom;
    const color = zone.color || def.color;
    octx.save();
    octx.fillStyle = hexToRgba(color, 0.22);
    octx.strokeStyle = hexToRgba(color, 0.9);
    octx.lineWidth = 1.5;
    let labelPos = null;
    if (zone.shape === 'rect') {
      const corners = rotatedRectCorners(zone).map(toScreen);
      octx.beginPath();
      corners.forEach((p, i) => (i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y)));
      octx.closePath(); octx.fill(); octx.stroke();
      const b = rectBounds(zone);
      labelPos = toScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    } else if (zone.shape === 'circle') {
      const c = toScreen({ x: zone.cx, y: zone.cy });
      octx.beginPath();
      octx.arc(c.x, c.y, Math.max(1, zone.r * scale), 0, Math.PI * 2);
      octx.fill(); octx.stroke();
      labelPos = c;
    } else if (zone.shape === 'polygon' && (zone.points || []).length >= 2) {
      const pts = zone.points.map(toScreen);
      octx.beginPath();
      pts.forEach((p, i) => (i === 0 ? octx.moveTo(p.x, p.y) : octx.lineTo(p.x, p.y)));
      octx.closePath(); octx.fill(); octx.stroke();
      const cx = zone.points.reduce((s, p) => s + p.x, 0) / zone.points.length;
      const cy = zone.points.reduce((s, p) => s + p.y, 0) / zone.points.length;
      labelPos = toScreen({ x: cx, y: cy });
    }
    octx.restore();
    if (labelPos) {
      octx.save();
      octx.fillStyle = '#f0f0f2';
      octx.font = '600 11px -apple-system, sans-serif';
      octx.textAlign = 'center'; octx.textBaseline = 'middle';
      octx.shadowColor = 'rgba(0,0,0,0.8)'; octx.shadowBlur = 3;
      octx.fillText(zone.name || def.label, labelPos.x, labelPos.y);
      octx.restore();
    }
  }

  for (const pt of venue.points || []) {
    const def = POINT_TYPES[pt.type] ?? POINT_TYPES.entrance;
    const color = pt.color || def.color;
    const sp = toScreen(pt);
    const r = 7;
    octx.save();
    octx.beginPath();
    octx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    octx.fillStyle = color; octx.fill();
    octx.strokeStyle = 'rgba(0,0,0,0.4)'; octx.lineWidth = 1; octx.stroke();
    octx.fillStyle = '#111114';
    octx.font = '700 8px -apple-system, sans-serif';
    octx.textAlign = 'center'; octx.textBaseline = 'middle';
    octx.fillText(def.glyph, sp.x, sp.y + 0.5);
    octx.fillStyle = '#f0f0f2';
    octx.font = '600 10px -apple-system, sans-serif';
    octx.textAlign = 'left'; octx.textBaseline = 'middle';
    octx.shadowColor = 'rgba(0,0,0,0.8)'; octx.shadowBlur = 3;
    octx.fillText(pt.name || def.label, sp.x + r + 4, sp.y);
    octx.restore();
  }
}

/** Sizes an overlay canvas's CSS box AND its pixel buffer to exactly match
 * the density canvas it's stacked on (so the two align pixel-for-pixel),
 * then redraws it — the overlay uses a much higher-resolution buffer than
 * the density canvas (1 device px per CSS px, not 1 per grid cell), so
 * vector strokes/text stay crisp instead of inheriting the heatmap's
 * deliberately blocky look. */
function fitOverlay(overlayEl, densityEl, venue, payload) {
  overlayEl.style.width = densityEl.style.width;
  overlayEl.style.height = densityEl.style.height;
  const cssW = Math.max(1, Math.round(parseFloat(densityEl.style.width) || densityEl.width));
  const cssH = Math.max(1, Math.round(parseFloat(densityEl.style.height) || densityEl.height));
  overlayEl.width = cssW;
  overlayEl.height = cssH;
  drawDesignerOverlay(overlayEl, venue, payload);
}

/**
 * Sizes the canvas's on-screen (CSS) box to fit whatever space is actually
 * available in the window right now, independent of the grid's cell count
 * — a fine grid (small cell size -> many cols/rows) used to hit a "never
 * shrink below 1 CSS px per cell" floor and render far larger than the
 * window, forcing a scroll/zoomed-in view instead of fitting like a
 * coarser grid did. Contain-fit against the wrapper's own current size
 * instead, with only a loose upper cap so a tiny grid doesn't blow up to
 * fill an ultrawide window.
 */
function fitCanvasToContainer() {
  if (mode === 'compare') {
    if (!cmpBefore || !cmpAfter) return;
    // Each pane gets roughly half the available width (minus the gap
    // between panes and their labels' vertical space).
    const availW = Math.max(50, canvasWrap.clientWidth / 2 - 40);
    const availH = Math.max(50, canvasWrap.clientHeight - 50);
    const fitOne = (payload, el) => {
      const scale = Math.max(0.05, Math.min(40, availW / payload.cols, availH / payload.rows));
      el.style.width = `${payload.cols * scale}px`;
      el.style.height = `${payload.rows * scale}px`;
    };
    fitOne(cmpBefore, canvasBefore);
    fitOne(cmpAfter, canvasAfter);
    fitOverlay(overlayCanvasBefore, canvasBefore, cmpBefore.venue, cmpBefore);
    fitOverlay(overlayCanvasAfter, canvasAfter, cmpAfter.venue, cmpAfter);
    return;
  }
  if (!current) return;
  const availW = Math.max(50, canvasWrap.clientWidth - 24);
  const availH = Math.max(50, canvasWrap.clientHeight - 24);
  const scale = Math.max(0.05, Math.min(40, availW / current.cols, availH / current.rows));
  canvas.style.width = `${current.cols * scale}px`;
  canvas.style.height = `${current.rows * scale}px`;
  fitOverlay(overlayCanvas, canvas, current.venue, current);
}
window.addEventListener('resize', fitCanvasToContainer);

// A dark-purple -> hot-yellow sequential colormap, matching the legend's
// CSS gradient in the HTML.
const STOPS = [
  [26, 27, 30], [59, 31, 107], [164, 34, 110], [224, 86, 79], [242, 201, 74], [255, 246, 217],
];
function colorForDensity(t) {
  t = Math.max(0, Math.min(1, t));
  const scaled = t * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(scaled));
  const localT = scaled - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * localT),
    Math.round(a[1] + (b[1] - a[1]) * localT),
    Math.round(a[2] + (b[2] - a[2]) * localT),
  ];
}

const WALL_COLOR = [10, 10, 12];

/** Paints one frame's density grid into a 2D context at native
 * (1 CSS px per cell) resolution — CSS scaling handles the on-screen
 * size. Shared by single mode and both compare panes. */
function paintFrame(targetCtx, payload, displayMax, idx) {
  const frame = payload.frames[idx];
  const domain = payload.domainMask;
  const imageData = targetCtx.createImageData(payload.cols, payload.rows);
  for (let i = 0; i < frame.length; i++) {
    const o = i * 4;
    if (!domain[i]) {
      imageData.data[o] = WALL_COLOR[0];
      imageData.data[o + 1] = WALL_COLOR[1];
      imageData.data[o + 2] = WALL_COLOR[2];
      imageData.data[o + 3] = 255;
      continue;
    }
    const color = colorForDensity(frame[i] / displayMax);
    imageData.data[o] = color[0];
    imageData.data[o + 1] = color[1];
    imageData.data[o + 2] = color[2];
    imageData.data[o + 3] = 255;
  }
  targetCtx.putImageData(imageData, 0, 0);
}

/** 95th-percentile-of-walkable-peaks display ceiling — see the comment in
 * the pre-compare version of this file (still true per-run): a single
 * busy door's raw peak would otherwise wash out the rest of the map. */
function robustDisplayMax(payload) {
  const walkablePeaks = [];
  for (let i = 0; i < payload.metrics.peakDensity.length; i++) {
    if (payload.domainMask[i] && payload.metrics.peakDensity[i] > 0) walkablePeaks.push(payload.metrics.peakDensity[i]);
  }
  walkablePeaks.sort((a, b) => a - b);
  const robustPeak = walkablePeaks.length
    ? walkablePeaks[Math.min(walkablePeaks.length - 1, Math.floor(0.95 * walkablePeaks.length))]
    : 0;
  return Math.max(payload.rhoMax, robustPeak);
}

function render(payload) {
  if (playTimer) clearInterval(playTimer);
  playing = false;
  playBtn.textContent = '▶';
  frameIdx = 0;

  if (payload && payload.compare) {
    renderCompare(payload);
  } else {
    renderSingle(payload);
  }
}

function renderSingle(payload) {
  mode = 'single';
  current = payload;
  cmpBefore = null;
  cmpAfter = null;

  titleEl.textContent = payload.title || 'Density Playback';
  subtitleEl.textContent =
    `${payload.cols}×${payload.rows} cells · ${payload.cellSize} ${payload.unit}/cell · ` +
    `Δt ${payload.dt}s · ${payload.frames.length} frames over ${payload.totalTime}s`;
  warningsEl.textContent = (payload.warnings || []).join('  ·  ');

  emptyStateEl.style.display = 'none';
  singleFrameEl.style.display = 'block';
  compareWrapEl.style.display = 'none';
  controlsEl.style.display = 'flex';

  canvas.width = payload.cols;
  canvas.height = payload.rows;

  let peak = 0;
  for (const v of payload.metrics.peakDensity) if (v > peak) peak = v;
  current.displayMax = robustDisplayMax(payload);

  legendMaxEl.textContent = `${current.displayMax.toFixed(1)} people/m²${peak > current.displayMax * 1.05 ? ` (typical high — true peak is ${peak.toFixed(1)}, see stats below)` : ''}`;

  scrub.min = 0;
  scrub.max = payload.frames.length - 1;
  scrub.value = 0;

  document.getElementById('stat-admitted').textContent = payload.ledger.admitted.toFixed(1);
  document.getElementById('stat-exited').textContent = payload.ledger.exited.toFixed(1);
  document.getElementById('stat-clipped').textContent = payload.ledger.clipped.toFixed(1);
  document.getElementById('stat-residual').textContent = payload.ledger.residual.toFixed(3);
  document.getElementById('stat-t95').textContent = payload.metrics.t95 != null ? `${payload.metrics.t95.toFixed(1)} s` : '— (no forced evacuation phase)';
  document.getElementById('stat-peak').textContent = `${peak.toFixed(2)} people/m²`;

  fitCanvasToContainer();
  drawFrame(0);
}

function renderCompare(payload) {
  mode = 'compare';
  const { before, after } = payload.compare;
  current = null;
  cmpBefore = before;
  cmpAfter = after;

  titleEl.textContent = payload.title || 'Density Comparison';
  subtitleEl.textContent =
    `Before: ${before.cols}×${before.rows} cells · After: ${after.cols}×${after.rows} cells · ` +
    `Δt ${before.dt}s · ${before.frames.length} frames over ${before.totalTime}s`;
  const warnings = [
    ...(before.warnings || []).map((w) => `Before: ${w}`),
    ...(after.warnings || []).map((w) => `After: ${w}`),
  ];
  warningsEl.textContent = warnings.join('  ·  ');

  emptyStateEl.style.display = 'none';
  singleFrameEl.style.display = 'none';
  compareWrapEl.style.display = 'flex';
  controlsEl.style.display = 'flex';

  canvasBefore.width = before.cols;
  canvasBefore.height = before.rows;
  canvasAfter.width = after.cols;
  canvasAfter.height = after.rows;

  let peakBefore = 0;
  for (const v of before.metrics.peakDensity) if (v > peakBefore) peakBefore = v;
  let peakAfter = 0;
  for (const v of after.metrics.peakDensity) if (v > peakAfter) peakAfter = v;

  // One shared scale for both panes — computed from whichever run has the
  // higher robust ceiling — so a color means the same density in both
  // panes and the two can be compared directly at a glance.
  const sharedMax = Math.max(robustDisplayMax(before), robustDisplayMax(after));
  before.displayMax = sharedMax;
  after.displayMax = sharedMax;

  const overallPeak = Math.max(peakBefore, peakAfter);
  legendMaxEl.textContent = `${sharedMax.toFixed(1)} people/m² (shared scale)${overallPeak > sharedMax * 1.05 ? ` — true peak is ${overallPeak.toFixed(1)}, see stats below` : ''}`;

  scrub.min = 0;
  scrub.max = before.frames.length - 1;
  scrub.value = 0;

  const pair = (b, a, digits = 1) => `${b.toFixed(digits)} → ${a.toFixed(digits)}`;
  document.getElementById('stat-admitted').textContent = pair(before.ledger.admitted, after.ledger.admitted);
  document.getElementById('stat-exited').textContent = pair(before.ledger.exited, after.ledger.exited);
  document.getElementById('stat-clipped').textContent = pair(before.ledger.clipped, after.ledger.clipped);
  document.getElementById('stat-residual').textContent = pair(before.ledger.residual, after.ledger.residual, 3);
  document.getElementById('stat-t95').textContent = '— (no forced evacuation phase)';
  document.getElementById('stat-peak').textContent = `${pair(peakBefore, peakAfter, 2)} people/m²`;

  fitCanvasToContainer();
  drawFrame(0);
}

function drawFrame(i) {
  const n = frameCount();
  if (n === 0) return;
  frameIdx = Math.max(0, Math.min(n - 1, i));

  if (mode === 'compare') {
    paintFrame(ctxBefore, cmpBefore, cmpBefore.displayMax, frameIdx);
    paintFrame(ctxAfter, cmpAfter, cmpAfter.displayMax, frameIdx);
    scrub.value = frameIdx;
    timeReadoutEl.textContent = `t = ${cmpBefore.times[frameIdx].toFixed(1)} s / ${totalTimeOf()} s`;
    return;
  }

  paintFrame(ctx, current, current.displayMax, frameIdx);
  scrub.value = frameIdx;
  timeReadoutEl.textContent = `t = ${current.times[frameIdx].toFixed(1)} s / ${totalTimeOf()} s`;
}

function togglePlay() {
  if (frameCount() === 0) return;
  playing = !playing;
  playBtn.textContent = playing ? '⏸' : '▶';
  if (playing) {
    playTimer = setInterval(() => {
      let next = frameIdx + 1;
      if (next >= frameCount()) next = 0; // loop
      drawFrame(next);
    }, 1000 / 20); // 20 fps playback
  } else if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

playBtn.addEventListener('click', togglePlay);
scrub.addEventListener('input', () => {
  if (playing) togglePlay(); // scrubbing manually pauses playback
  drawFrame(Number(scrub.value));
});

/** Exact per-cell density at the cursor, for the currently-displayed
 * frame — precise numbers to compare (e.g. "stage front" vs "back of the
 * crowd"), rather than relying on how two colors look next to each other
 * on the colormap. */
function updateHover(payload, cell, label) {
  if (!payload) return;
  if (!cell) {
    hoverInfoEl.textContent = "Hover the grid for a cell's exact density";
    return;
  }
  const { col, row } = cell;
  const idx = row * payload.cols + col;
  const worldX = payload.originX + (col + 0.5) * payload.cellSize;
  const worldY = payload.originY + (row + 0.5) * payload.cellSize;
  const density = payload.domainMask[idx]
    ? `${payload.frames[frameIdx][idx].toFixed(2)} people/m²`
    : 'wall/obstacle';
  const prefix = label ? `${label} · ` : '';
  hoverInfoEl.textContent = `${prefix}col ${col}, row ${row} · (${worldX.toFixed(1)}, ${worldY.toFixed(1)} ${payload.unit}) · ${density}`;
}

function cellUnderCursor(el, e, payload) {
  const rect = el.getBoundingClientRect();
  const col = Math.floor(((e.clientX - rect.left) / rect.width) * payload.cols);
  const row = Math.floor(((e.clientY - rect.top) / rect.height) * payload.rows);
  if (col < 0 || row < 0 || col >= payload.cols || row >= payload.rows) return null;
  return { col, row };
}

canvas.addEventListener('mousemove', (e) => {
  if (mode !== 'single' || !current) return;
  updateHover(current, cellUnderCursor(canvas, e, current), null);
});
canvas.addEventListener('mouseleave', () => updateHover(null, null));

canvasBefore.addEventListener('mousemove', (e) => {
  if (mode !== 'compare' || !cmpBefore) return;
  updateHover(cmpBefore, cellUnderCursor(canvasBefore, e, cmpBefore), 'Before');
});
canvasBefore.addEventListener('mouseleave', () => updateHover(null, null));
canvasAfter.addEventListener('mousemove', (e) => {
  if (mode !== 'compare' || !cmpAfter) return;
  updateHover(cmpAfter, cellUnderCursor(canvasAfter, e, cmpAfter), 'After');
});
canvasAfter.addEventListener('mouseleave', () => updateHover(null, null));

window.densityViewer?.onData(render);
