// A small, self-contained debug viewer: renders whatever mask payload the
// main window pushes over IPC (see window.maskViewer.onData). Binary masks
// (walkability/barrier/attraction) render black/white; the open-range
// entrance/exit-rate mask renders a diverging blue-white-red gradient with
// a legend. No build step, no framework — just canvas + DOM.

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const emptyStateEl = document.getElementById('empty-state');
const canvas = document.getElementById('mask-canvas');
const footerEl = document.getElementById('footer');
const hoverInfoEl = document.getElementById('hover-info');
const legendEl = document.getElementById('legend');
const legendGradientEl = document.getElementById('legend-gradient');
const legendMinEl = document.getElementById('legend-min');
const legendMaxEl = document.getElementById('legend-max');
const canvasWrap = document.getElementById('canvas-wrap');
const ctx = canvas.getContext('2d');

/**
 * Sizes the canvas's on-screen (CSS) box to fit whatever space is actually
 * available right now, independent of the grid's cell count — a fine
 * cell size (many cols/rows) used to hit a "never shrink below 1 CSS px
 * per cell" floor and render far larger than the window instead of
 * fitting like a coarser grid did. Contain-fit against the wrapper's own
 * current size instead, with only a loose upper cap.
 */
function fitCanvasToContainer() {
  if (!current) return;
  const availW = Math.max(50, canvasWrap.clientWidth - 24);
  const availH = Math.max(50, canvasWrap.clientHeight - 24);
  const scale = Math.max(0.05, Math.min(40, availW / current.cols, availH / current.rows));
  canvas.style.width = `${current.cols * scale}px`;
  canvas.style.height = `${current.rows * scale}px`;
}
window.addEventListener('resize', fitCanvasToContainer);

// Short, mask-type-specific wording for what black/white mean — plain
// "1/0" is unambiguous as data but not as a picture.
const BINARY_LEGEND = {
  walkability: '⬜ walkable (1) · ⬛ blocked (0)',
  barrier: '⬜ editable barrier (1) · ⬛ none (0)',
  attraction: '⬜ attraction area (1) · ⬛ none (0)',
};

let current = null; // last payload, kept for hover lookups

function render(payload) {
  current = payload;
  titleEl.textContent = payload.title || 'Mask Viewer';
  subtitleEl.textContent =
    `${payload.type} · ${payload.cols}×${payload.rows} cells · ` +
    `${payload.cellSize} ${payload.unit}/cell`;

  emptyStateEl.style.display = 'none';
  canvas.style.display = 'block';
  footerEl.style.display = 'flex';

  canvas.width = payload.cols;
  canvas.height = payload.rows;
  fitCanvasToContainer();

  const imageData = ctx.createImageData(payload.cols, payload.rows);
  if (payload.binary) {
    renderBinary(payload, imageData);
    legendEl.style.display = 'none';
    hoverInfoEl.dataset.legend = BINARY_LEGEND[payload.type] ?? "Hover the grid for a cell's value";
  } else {
    renderGradient(payload, imageData);
    legendEl.style.display = 'flex';
    hoverInfoEl.dataset.legend = "Hover the grid for a cell's value";
  }
  ctx.putImageData(imageData, 0, 0);
  updateHover(null);
}

function renderBinary(payload, imageData) {
  for (let i = 0; i < payload.grid.length; i++) {
    const on = payload.grid[i] ? 255 : 0;
    const o = i * 4;
    imageData.data[o] = on;
    imageData.data[o + 1] = on;
    imageData.data[o + 2] = on;
    imageData.data[o + 3] = 255;
  }
}

const NEGATIVE_COLOR = [79, 143, 214]; // blue — exits
const POSITIVE_COLOR = [224, 86, 79]; // red — entrances
const NEUTRAL_COLOR = [235, 235, 238]; // near-white — zero

function lerpColor(from, to, t) {
  return [0, 1, 2].map((i) => Math.round(from[i] + (to[i] - from[i]) * t));
}

function renderGradient(payload, imageData) {
  let min = 0, max = 0;
  for (const v of payload.grid) { if (v < min) min = v; if (v > max) max = v; }

  for (let i = 0; i < payload.grid.length; i++) {
    const v = payload.grid[i];
    let color;
    if (v === 0) color = NEUTRAL_COLOR;
    else if (v > 0) color = lerpColor(NEUTRAL_COLOR, POSITIVE_COLOR, max > 0 ? v / max : 0);
    else color = lerpColor(NEUTRAL_COLOR, NEGATIVE_COLOR, min < 0 ? v / min : 0);
    const o = i * 4;
    imageData.data[o] = color[0];
    imageData.data[o + 1] = color[1];
    imageData.data[o + 2] = color[2];
    imageData.data[o + 3] = 255;
  }

  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(2));
  legendMinEl.textContent = `${fmt(min)} (exit)`;
  legendMaxEl.textContent = `${fmt(max)} (entrance)`;
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  legendGradientEl.style.background = min < 0 || max > 0
    ? `linear-gradient(to right, ${rgb(NEGATIVE_COLOR)}, ${rgb(NEUTRAL_COLOR)}, ${rgb(POSITIVE_COLOR)})`
    : rgb(NEUTRAL_COLOR);
}

function updateHover(cell) {
  if (!current) return;
  if (!cell) {
    hoverInfoEl.textContent = hoverInfoEl.dataset.legend || "Hover the grid for a cell's value";
    return;
  }
  const { col, row } = cell;
  const value = current.grid[row * current.cols + col];
  const worldX = current.originX + (col + 0.5) * current.cellSize;
  const worldY = current.originY + (row + 0.5) * current.cellSize;
  hoverInfoEl.textContent =
    `col ${col}, row ${row} · (${worldX.toFixed(2)}, ${worldY.toFixed(2)} ${current.unit}) · value = ${value}`;
}

canvas.addEventListener('mousemove', (e) => {
  if (!current) return;
  const rect = canvas.getBoundingClientRect();
  const col = Math.floor(((e.clientX - rect.left) / rect.width) * current.cols);
  const row = Math.floor(((e.clientY - rect.top) / rect.height) * current.rows);
  if (col < 0 || row < 0 || col >= current.cols || row >= current.rows) { updateHover(null); return; }
  updateHover({ col, row });
});
canvas.addEventListener('mouseleave', () => updateHover(null));

window.maskViewer?.onData(render);
