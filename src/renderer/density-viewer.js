// Playback window for a finished density simulation — renders each
// recorded density frame as a heatmap (walls/obstacles shown as a fixed
// dark backdrop, density from a sequential dark-to-hot colormap), with
// play/pause and a scrub slider over the recorded time steps.

const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const warningsEl = document.getElementById('warnings');
const emptyStateEl = document.getElementById('empty-state');
const canvas = document.getElementById('density-canvas');
const controlsEl = document.getElementById('controls');
const playBtn = document.getElementById('play-btn');
const scrub = document.getElementById('scrub');
const timeReadoutEl = document.getElementById('time-readout');
const legendMaxEl = document.getElementById('legend-max');
const hoverInfoEl = document.getElementById('hover-info');
const canvasWrap = document.getElementById('canvas-wrap');
const ctx = canvas.getContext('2d');

let current = null; // last payload
let frameIdx = 0;
let playing = false;
let playTimer = null;

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
  if (!current) return;
  const availW = Math.max(50, canvasWrap.clientWidth - 24);
  const availH = Math.max(50, canvasWrap.clientHeight - 24);
  const scale = Math.max(0.05, Math.min(40, availW / current.cols, availH / current.rows));
  canvas.style.width = `${current.cols * scale}px`;
  canvas.style.height = `${current.rows * scale}px`;
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

function render(payload) {
  current = payload;
  frameIdx = 0;
  playing = false;
  if (playTimer) clearInterval(playTimer);
  playBtn.textContent = '▶';

  titleEl.textContent = payload.title || 'Density Playback';
  subtitleEl.textContent =
    `${payload.cols}×${payload.rows} cells · ${payload.cellSize} ${payload.unit}/cell · ` +
    `Δt ${payload.dt}s · ${payload.frames.length} frames over ${payload.totalTime}s`;
  warningsEl.textContent = (payload.warnings || []).join('  ·  ');

  emptyStateEl.style.display = 'none';
  canvas.style.display = 'block';
  controlsEl.style.display = 'flex';

  canvas.width = payload.cols;
  canvas.height = payload.rows;
  fitCanvasToContainer();

  let peak = 0;
  for (const v of payload.metrics.peakDensity) if (v > peak) peak = v;

  // A single busy door funnels its whole admission rate through a handful
  // of cells — genuinely crowded there, but a narrow, physically-expected
  // choke point, not representative of the crowd generally. Scaling the
  // whole colormap to that one hotspot's raw max washes out the *actual*
  // interesting variation everywhere else (a real, meaningful gradient
  // from a stage front to the back of a crowd can end up compressed into
  // a sliver of the color range, reading as flat even though it isn't).
  // A high percentile of walkable cells' own peak values is robust to a
  // handful of such outlier cells while still capturing genuine
  // widespread crush (which spans many cells, not a handful, and so
  // still pulls the percentile itself up). ρ_max stays the floor either
  // way — it's still a meaningful physical reference line.
  const walkablePeaks = [];
  for (let i = 0; i < payload.metrics.peakDensity.length; i++) {
    if (payload.domainMask[i] && payload.metrics.peakDensity[i] > 0) walkablePeaks.push(payload.metrics.peakDensity[i]);
  }
  walkablePeaks.sort((a, b) => a - b);
  const robustPeak = walkablePeaks.length
    ? walkablePeaks[Math.min(walkablePeaks.length - 1, Math.floor(0.95 * walkablePeaks.length))]
    : 0;
  current.displayMax = Math.max(payload.rhoMax, robustPeak);

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

  drawFrame(0);
}

function drawFrame(i) {
  if (!current) return;
  frameIdx = Math.max(0, Math.min(current.frames.length - 1, i));
  const frame = current.frames[frameIdx];
  const domain = current.domainMask;
  const displayMax = current.displayMax;

  const imageData = ctx.createImageData(current.cols, current.rows);
  for (let idx = 0; idx < frame.length; idx++) {
    const o = idx * 4;
    if (!domain[idx]) {
      imageData.data[o] = WALL_COLOR[0];
      imageData.data[o + 1] = WALL_COLOR[1];
      imageData.data[o + 2] = WALL_COLOR[2];
      imageData.data[o + 3] = 255;
      continue;
    }
    const color = colorForDensity(frame[idx] / displayMax);
    imageData.data[o] = color[0];
    imageData.data[o + 1] = color[1];
    imageData.data[o + 2] = color[2];
    imageData.data[o + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);

  scrub.value = frameIdx;
  timeReadoutEl.textContent = `t = ${current.times[frameIdx].toFixed(1)} s / ${current.totalTime} s`;
}

function togglePlay() {
  if (!current) return;
  playing = !playing;
  playBtn.textContent = playing ? '⏸' : '▶';
  if (playing) {
    playTimer = setInterval(() => {
      let next = frameIdx + 1;
      if (next >= current.frames.length) next = 0; // loop
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
function updateHover(cell) {
  if (!current) return;
  if (!cell) {
    hoverInfoEl.textContent = "Hover the grid for a cell's exact density";
    return;
  }
  const { col, row } = cell;
  const idx = row * current.cols + col;
  const worldX = current.originX + (col + 0.5) * current.cellSize;
  const worldY = current.originY + (row + 0.5) * current.cellSize;
  const label = current.domainMask[idx]
    ? `${current.frames[frameIdx][idx].toFixed(2)} people/m²`
    : 'wall/obstacle';
  hoverInfoEl.textContent = `col ${col}, row ${row} · (${worldX.toFixed(1)}, ${worldY.toFixed(1)} ${current.unit}) · ${label}`;
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

window.densityViewer?.onData(render);
