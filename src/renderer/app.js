import { VenueModel } from './model/VenueModel.js';
import { CanvasView } from './canvas/CanvasView.js';
import { InputController } from './canvas/InputController.js';
import { renderProperties } from './ui/properties.js';
import { zoneArea } from './canvas/geometry.js';
import { promptModal, confirmModal } from './ui/modal.js';
import {
  computeWalkabilityGrid, computeBarrierMask, computeEntranceExitMask, computeAttractionMask, maskToJSON,
} from './sim/masks.js';
import { runDensitySimulation } from './sim/density.js';
import { runAgentSimulation } from './sim/density-agents.js';

const model = new VenueModel();
const canvas = document.getElementById('venue-canvas');
const view = new CanvasView(canvas, model);

let activeTool = 'select';
// Constructed further down, once every DOM element and helper function its
// hooks touch has actually been declared — see the note near the bottom of
// this file for why that order matters.
let input;

view.centerView();
view.render();

// ---------------------------------------------------------------------------
// Tool selection
// ---------------------------------------------------------------------------

function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  document.getElementById('status-tool').textContent = `Tool: ${labelForTool(tool)}`;
  input.onToolChanged();
}

function labelForTool(tool) {
  return {
    select: 'Select', pan: 'Pan', wall: 'Wall', pillar: 'Pillar', 'wall-rect': 'Block',
    'rect-zone': 'Rectangle Zone', 'circle-zone': 'Circle Zone', 'poly-zone': 'Polygon Zone',
    point: 'Point Marker', measure: 'Measure', calibrate: 'Calibrate',
  }[tool] ?? tool;
}

document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

document.getElementById('btn-calibrate').addEventListener('click', () => setTool('calibrate'));

// ---------------------------------------------------------------------------
// Hint bar / status bar
// ---------------------------------------------------------------------------

const hintBar = document.getElementById('hint-bar');
function setHint(text) {
  hintBar.textContent = text;
  hintBar.classList.toggle('visible', Boolean(text));
}

const coordsEl = document.getElementById('status-coords');
function setCoords(world) {
  const unit = model.venue.meta.unit;
  coordsEl.textContent = `x: ${world.x.toFixed(2)} ${unit}, y: ${world.y.toFixed(2)} ${unit}`;
}

const fileStatusEl = document.getElementById('status-file');
function updateFileStatus() {
  const name = model.filePath ? model.filePath.split(/[\\/]/).pop() : 'Unsaved venue';
  fileStatusEl.textContent = model.dirty ? `${name} •` : name;
}

// ---------------------------------------------------------------------------
// Zoom controls
// ---------------------------------------------------------------------------

const zoomReadout = document.getElementById('zoom-readout');
function setZoomReadout(zoom) {
  zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
}
document.getElementById('zoom-in').addEventListener('click', () => {
  view.zoomBy(1.2);
  setZoomReadout(view.zoom);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  view.zoomBy(1 / 1.2);
  setZoomReadout(view.zoom);
});
document.getElementById('zoom-fit').addEventListener('click', () => {
  view.fitToContent();
  setZoomReadout(view.zoom);
});

// ---------------------------------------------------------------------------
// Properties panel
// ---------------------------------------------------------------------------

const propertiesContent = document.getElementById('properties-content');
function renderPropertiesPanel(selection) {
  renderProperties(propertiesContent, model, selection, {
    onChange: () => { view.render(); updateSummary(); updateFileStatus(); },
    onDelete: (sel) => {
      model.removeById(`${sel.kind}s`, sel.id);
      model.commit();
      view.selection = null;
      view.selectedVertex = null;
      renderPropertiesPanel(null);
      view.render();
      updateSummary();
    },
  });
}

// ---------------------------------------------------------------------------
// Layers panel
// ---------------------------------------------------------------------------

const layerCheckboxes = {
  background: document.getElementById('layer-background'),
  grid: document.getElementById('layer-grid'),
  walls: document.getElementById('layer-walls'),
  zones: document.getElementById('layer-zones'),
  points: document.getElementById('layer-points'),
  walkability: document.getElementById('layer-walkability'),
};
for (const [key, el] of Object.entries(layerCheckboxes)) {
  el.addEventListener('change', () => {
    view.layers[key] = el.checked;
    view.render();
  });
}

const bgOpacitySlider = document.getElementById('bg-opacity');
bgOpacitySlider.addEventListener('input', () => {
  view.bgOpacity = Number(bgOpacitySlider.value) / 100;
  view.render();
});

// ---------------------------------------------------------------------------
// Simulation masks (walkability, barrier, entrance/exit rate, attraction)
// ---------------------------------------------------------------------------

function pct(count, total) {
  return total ? Math.round((count / total) * 100) : 0;
}

const MASK_TYPES = {
  walkability: {
    label: 'Walkability',
    compute: (cellSize) => computeWalkabilityGrid(model.venue, cellSize),
    stats: (mask) => `${mask.cols} × ${mask.rows} cells · ${pct(mask.walkableCount, mask.cols * mask.rows)}% walkable`,
  },
  barrier: {
    label: 'Barrier (movable/extendable)',
    compute: (cellSize) => computeBarrierMask(model.venue, cellSize),
    stats: (mask) => `${mask.cols} × ${mask.rows} cells · ${mask.barrierCount} editable-barrier cells`,
  },
  'entrance-exit-rate': {
    label: 'Entrance/Exit rate',
    compute: (cellSize) => computeEntranceExitMask(model.venue, cellSize),
    stats: (mask) => `${mask.cols} × ${mask.rows} cells · ${mask.openCount} open entrance/exit cell(s)`,
  },
  attraction: {
    label: 'Attraction',
    compute: (cellSize) => computeAttractionMask(model.venue, cellSize),
    stats: (mask) => `${mask.cols} × ${mask.rows} cells · ${pct(mask.attractionCount, mask.cols * mask.rows)}% attraction area`,
  },
};

const maskTypeSelect = document.getElementById('mask-type-select');
const maskCellSizeInput = document.getElementById('mask-cell-size');
const maskStatsEl = document.getElementById('mask-stats');

function currentMaskEntry() {
  return MASK_TYPES[maskTypeSelect.value];
}

/** Computes the currently-selected mask, showing a modal (not just the
 * inline stats line) if it fails — used by the two explicit actions
 * (debug view / export) where silently doing nothing would be confusing. */
async function computeCurrentMaskOrWarn() {
  try {
    return currentMaskEntry().compute(view.maskCellSize);
  } catch (err) {
    await confirmModal({ title: `Can’t compute ${currentMaskEntry().label} mask`, message: err.message });
    return null;
  }
}

function updateMaskStats() {
  try {
    maskStatsEl.textContent = currentMaskEntry().stats(currentMaskEntry().compute(view.maskCellSize));
  } catch (err) {
    maskStatsEl.textContent = err.message;
  }
}

maskTypeSelect.addEventListener('change', updateMaskStats);
maskCellSizeInput.addEventListener('input', () => {
  const value = Number(maskCellSizeInput.value);
  if (!(value > 0)) return;
  view.maskCellSize = value;
  view.render(); // in case the walkability canvas overlay is showing
  updateMaskStats();
});

document.getElementById('btn-export-mask').addEventListener('click', async () => {
  const mask = await computeCurrentMaskOrWarn();
  if (!mask) return;
  const json = JSON.stringify(maskToJSON(mask, model.venue.meta.name), null, 2);
  const defaultPath = `${(model.venue.meta.name || 'venue').replace(/[^\w\- ]/g, '')}.${mask.type}.mask.json`;
  await window.crowdsense.exportMask(json, defaultPath);
});

document.getElementById('btn-debug-mask').addEventListener('click', async () => {
  const mask = await computeCurrentMaskOrWarn();
  if (!mask) return;
  await window.crowdsense.openMaskViewer({
    title: `${model.venue.meta.name} — ${currentMaskEntry().label}`,
    type: mask.type,
    binary: mask.binary,
    unit: mask.unit,
    cellSize: mask.cellSize,
    originX: mask.originX,
    originY: mask.originY,
    cols: mask.cols,
    rows: mask.rows,
    grid: Array.from(mask.grid),
  });
});

// ---------------------------------------------------------------------------
// Crowd simulation (density over time)
// ---------------------------------------------------------------------------

const densityEngineSelect = document.getElementById('density-engine');
const densityMaxPeopleInput = document.getElementById('density-max-people');
const densityDtInput = document.getElementById('density-dt');
const densityTotalTimeInput = document.getElementById('density-total-time');
const densityStatusEl = document.getElementById('density-status');
const btnRunDensity = document.getElementById('btn-run-density');
const optimizerTrainSamplesInput = document.getElementById('optimizer-train-samples');
const btnOptimizeLayout = document.getElementById('btn-optimize-layout');

/** Reads the panel's current inputs and runs a simulation, or returns
 * null (after showing a modal) if the inputs are invalid. Shared by both
 * "Simulate Density…" and "Optimize Layout…", which only differ in what
 * they do with the finished result. */
async function runPanelSimulation(onProgress) {
  const maxPeople = Number(densityMaxPeopleInput.value);
  const dt = Number(densityDtInput.value);
  const totalTime = Number(densityTotalTimeInput.value);

  if (!(maxPeople > 0) || !(dt > 0) || !(totalTime > 0)) {
    await confirmModal({ title: 'Invalid simulation parameters', message: 'Max people, time step, and total time must all be positive numbers.' });
    return null;
  }

  const engine = densityEngineSelect.value;
  const runSimulation = engine === 'continuum' ? runDensitySimulation : runAgentSimulation;
  const result = await runSimulation({
    venue: model.venue,
    cellSize: view.maskCellSize,
    maxPeople,
    dt,
    totalTime,
    onProgress,
  });
  return { engine, result };
}

btnRunDensity.addEventListener('click', async () => {
  btnRunDensity.disabled = true;
  btnRunDensity.textContent = 'Simulating…';
  densityStatusEl.textContent = 'Starting…';

  try {
    const run = await runPanelSimulation((frac) => {
      densityStatusEl.textContent = `Simulating… ${Math.round(frac * 100)}%`;
    });
    if (!run) return; // invalid inputs — modal already shown
    const { result } = run;

    densityStatusEl.textContent = result.warnings.length
      ? result.warnings.join(' ')
      : `Done — ${result.frames.length} frames, admitted ${result.ledger.admitted.toFixed(0)}, exited ${result.ledger.exited.toFixed(0)}.`;

    // Typed arrays (Float32Array/Uint8Array frames, domainMask, etc.) pass
    // through Electron's IPC structured clone natively — no Array.from()
    // conversion needed here, unlike the mask viewer's JSON-export path.
    // `venue` rides along too, structured-cloned at send time (safe to
    // pass the live object — later edits here don't reach the already-sent
    // copy), so the playback window can overlay the actual designed
    // walls/zones/points on top of the density heatmap.
    await window.crowdsense.openDensityViewer({
      ...result,
      venue: model.venue,
      title: `${model.venue.meta.name} — Density Simulation`,
    });
  } catch (err) {
    await confirmModal({ title: 'Simulation failed', message: String(err.message || err) });
    densityStatusEl.textContent = '';
  } finally {
    btnRunDensity.disabled = false;
    btnRunDensity.textContent = 'Simulate Density…';
  }
});

// The optimizer itself now runs inside its own dedicated progress window
// (see optimizer-viewer.html/.js) rather than blocking this one — this
// button just hands that window everything it needs to run the pipeline
// and, later, re-simulate both layouts for a side-by-side comparison.
btnOptimizeLayout.addEventListener('click', async () => {
  const maxPeople = Number(densityMaxPeopleInput.value);
  const dt = Number(densityDtInput.value);
  const totalTime = Number(densityTotalTimeInput.value);
  const trainSamples = Math.round(Number(optimizerTrainSamplesInput.value));
  if (!(maxPeople > 0) || !(dt > 0) || !(totalTime > 0)) {
    await confirmModal({ title: 'Invalid simulation parameters', message: 'Max people, time step, and total time must all be positive numbers.' });
    return;
  }
  if (!(trainSamples > 0)) {
    await confirmModal({ title: 'Invalid training sample count', message: 'Training samples must be a positive number.' });
    return;
  }
  await window.crowdsense.openOptimizerViewer({
    venue: model.venue,
    engine: densityEngineSelect.value,
    maxPeople,
    dt,
    totalTime,
    cellSize: view.maskCellSize,
    trainSamples,
  });
});

// The optimizer-viewer window can't reach this window's venue model
// directly (separate renderer) — it asks main.js to forward the venue
// here when the user clicks "Load Optimized Layout Into Editor" there.
window.crowdsense.onApplyOptimizedVenue((venue) => {
  model.loadFromJSON(JSON.stringify(venue), null);
  refreshAfterHistoryChange();
  view.fitToContent();
  setZoomReadout(view.zoom);
});

// ---------------------------------------------------------------------------
// Summary panel
// ---------------------------------------------------------------------------

function updateSummary() {
  const v = model.venue;
  document.getElementById('summary-walls').textContent = String(v.walls.length);
  document.getElementById('summary-zones').textContent = String(v.zones.length);
  document.getElementById('summary-points').textContent = String(v.points.length);
  const totalArea = v.zones.reduce((sum, z) => sum + zoneArea(z), 0);
  document.getElementById('summary-area').textContent = v.zones.length
    ? `${totalArea.toFixed(1)} ${v.meta.unit}²`
    : '—';
}

// ---------------------------------------------------------------------------
// Venue name / unit / scale readout
// ---------------------------------------------------------------------------

const venueNameInput = document.getElementById('venue-name');
venueNameInput.addEventListener('change', () => {
  model.venue.meta.name = venueNameInput.value || 'Untitled Venue';
  model.commit();
  updateFileStatus();
});

const unitSelect = document.getElementById('unit-select');
const METERS_PER_FOOT = 0.3048;

/** Converts every stored coordinate so the drawing keeps the same real-world
 * size when the unit label changes — switching m -> ft should not silently
 * make everything appear ~3.28x bigger to the simulation side. */
function convertVenueUnits(venue, fromUnit, toUnit) {
  if (fromUnit === toUnit) return;
  const factor = fromUnit === 'm' && toUnit === 'ft' ? 1 / METERS_PER_FOOT : METERS_PER_FOOT;
  const scalePoint = (p) => { p.x *= factor; p.y *= factor; };

  const scaleShape = (s) => {
    if (s.shape === 'rect') { s.x *= factor; s.y *= factor; s.w *= factor; s.h *= factor; }
    else if (s.shape === 'circle' || s.shape === 'pillar') { s.cx *= factor; s.cy *= factor; s.r *= factor; }
    else s.points.forEach(scalePoint); // 'polygon', 'line', or an old wall with no `shape`
  };
  for (const wall of venue.walls) {
    scaleShape(wall);
    if (wall.thickness != null) wall.thickness *= factor;
  }
  for (const zone of venue.zones) scaleShape(zone);
  for (const point of venue.points) scalePoint(point);
  if (venue.background) {
    venue.background.x *= factor;
    venue.background.y *= factor;
    venue.background.width *= factor;
    venue.background.height *= factor;
  }
  // Keep on-screen pixel size (and therefore visual scale) unchanged.
  venue.scale.pixelsPerUnit /= factor;
}

unitSelect.addEventListener('change', () => {
  const fromUnit = model.venue.meta.unit;
  const toUnit = unitSelect.value;
  convertVenueUnits(model.venue, fromUnit, toUnit);
  model.venue.meta.unit = toUnit;
  model.commit();
  view.render();
});

const scaleReadout = document.getElementById('scale-readout');
function updateScaleReadout() {
  const { pixelsPerUnit } = model.venue.scale;
  const unit = model.venue.meta.unit;
  scaleReadout.textContent = `1 ${unit} = ${pixelsPerUnit.toFixed(1)} px`;
}

// ---------------------------------------------------------------------------
// Undo / redo / delete
// ---------------------------------------------------------------------------

function refreshAfterHistoryChange() {
  view.selection = null;
  view.selectedVertex = null;
  renderPropertiesPanel(null);
  view.render();
  updateSummary();
  updateFileStatus();
  venueNameInput.value = model.venue.meta.name;
  unitSelect.value = model.venue.meta.unit;
  updateScaleReadout();
}

document.getElementById('btn-undo').addEventListener('click', () => { model.undo(); refreshAfterHistoryChange(); });
document.getElementById('btn-redo').addEventListener('click', () => { model.redo(); refreshAfterHistoryChange(); });
document.getElementById('btn-delete').addEventListener('click', deleteSelection);

function deleteSelection() {
  // A single node clicked (not dragged) on a wall/polygon-zone takes
  // priority: Delete removes just that vertex, not the whole shape.
  if (view.selectedVertex) {
    deleteVertex(view.selectedVertex);
    return;
  }
  if (!view.selection) return;
  model.removeById(`${view.selection.kind}s`, view.selection.id);
  model.commit();
  view.selection = null;
  renderPropertiesPanel(null);
  view.render();
  updateSummary();
}

function deleteVertex({ kind, id, index }) {
  const item = model.find(`${kind}s`, id);
  view.selectedVertex = null;
  if (!item?.points) { view.render(); return; }

  item.points.splice(index, 1);
  // A wall needs at least 2 points (one segment); a polygon needs at
  // least 3. Drop below that and there's no valid shape left to keep.
  const minPoints = kind === 'wall' ? 2 : 3;
  if (item.points.length < minPoints) {
    model.removeById(`${kind}s`, id);
    view.selection = null;
  }
  model.commit();
  renderPropertiesPanel(view.selection);
  view.render();
  updateSummary();
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && (view.selection || view.selectedVertex)) {
    e.preventDefault();
    deleteSelection();
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) { model.redo(); } else { model.undo(); }
    refreshAfterHistoryChange();
  }
});

// ---------------------------------------------------------------------------
// File I/O — background image import
// ---------------------------------------------------------------------------

async function importBackground() {
  const result = await window.crowdsense.openImage();
  if (!result) return;
  const img = new Image();
  img.onload = () => {
    // Default: place at world origin, sized so its longest side is ~40 units.
    const aspect = img.naturalWidth / img.naturalHeight;
    const targetW = aspect >= 1 ? 40 : 40 * aspect;
    const targetH = aspect >= 1 ? 40 / aspect : 40;
    model.venue.background = {
      dataUrl: result.dataUrl,
      x: 0,
      y: 0,
      width: targetW,
      height: targetH,
      opacity: view.bgOpacity,
    };
    model.commit();
    view.render();
    view.fitToContent();
    setZoomReadout(view.zoom);
    updateSummary();
  };
  img.src = result.dataUrl;
}

// ---------------------------------------------------------------------------
// File I/O — venue import / save / export
// ---------------------------------------------------------------------------

async function importVenue() {
  if (model.dirty) {
    const proceed = await confirmModal({
      title: 'Discard unsaved changes?',
      message: 'Importing a venue will replace your current unsaved work.',
      okLabel: 'Discard & Import',
    });
    if (!proceed) return;
  }
  const result = await window.crowdsense.openVenue();
  if (!result) return;
  try {
    model.loadFromJSON(result.contents, result.filePath);
    refreshAfterHistoryChange();
    view.fitToContent();
    setZoomReadout(view.zoom);
  } catch (err) {
    await confirmModal({ title: 'Could not import venue', message: String(err.message || err) });
  }
}

async function saveVenue(forceDialog = false) {
  const contents = model.toJSON();
  if (model.filePath && !forceDialog) {
    await window.crowdsense.writeVenueFile(model.filePath, contents);
    model.markSaved(model.filePath);
    updateFileStatus();
    return;
  }
  const defaultPath = `${(model.venue.meta.name || 'venue').replace(/[^\w\- ]/g, '')}.venue`;
  const result = await window.crowdsense.saveVenue(contents, defaultPath);
  if (result) {
    model.markSaved(result.filePath);
    updateFileStatus();
  }
}

async function exportPng() {
  // Render a clean copy without selection/handles/hint overlays.
  const prevSelection = view.selection;
  const prevHover = view.hoverId;
  view.selection = null;
  view.hoverId = null;
  view.render();
  const dataUrl = canvas.toDataURL('image/png');
  view.selection = prevSelection;
  view.hoverId = prevHover;
  view.render();

  const defaultPath = `${(model.venue.meta.name || 'venue').replace(/[^\w\- ]/g, '')}.png`;
  await window.crowdsense.exportPng(dataUrl, defaultPath);
}

async function newVenue() {
  if (model.dirty) {
    const proceed = await confirmModal({
      title: 'Discard unsaved changes?',
      message: 'Starting a new venue will replace your current unsaved work.',
      okLabel: 'Discard & Continue',
    });
    if (!proceed) return;
  }
  model.reset();
  refreshAfterHistoryChange();
  view.centerView();
}

document.getElementById('btn-import-bg').addEventListener('click', importBackground);
document.getElementById('btn-import-venue').addEventListener('click', importVenue);
document.getElementById('btn-save-venue').addEventListener('click', () => saveVenue(false));
document.getElementById('btn-save-venue-as').addEventListener('click', () => saveVenue(true));
document.getElementById('btn-export-png').addEventListener('click', exportPng);

// ---------------------------------------------------------------------------
// Native menu wiring (from src/main/main.js)
// ---------------------------------------------------------------------------

window.crowdsense.onMenu('menu:new-venue', newVenue);
window.crowdsense.onMenu('menu:import-venue', importVenue);
window.crowdsense.onMenu('menu:import-background', importBackground);
window.crowdsense.onMenu('menu:save-venue', () => saveVenue(false));
window.crowdsense.onMenu('menu:save-venue-as', () => saveVenue(true));
window.crowdsense.onMenu('menu:export-png', exportPng);
window.crowdsense.onMenu('menu:undo', () => { model.undo(); refreshAfterHistoryChange(); });
window.crowdsense.onMenu('menu:redo', () => { model.redo(); refreshAfterHistoryChange(); });
window.crowdsense.onMenu('menu:delete-selection', deleteSelection);

window.addEventListener('beforeunload', (e) => {
  if (model.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Input controller
// ---------------------------------------------------------------------------
// Built last: its constructor synchronously calls hooks like setHint/setCoords
// (to paint the initial tool hint), so everything those hooks touch —
// hintBar, coordsEl, and the rest — must already exist above this line.

input = new InputController(canvas, view, model, {
  getTool: () => activeTool,
  setTool,
  onSelectionChange: (sel) => renderPropertiesPanel(sel),
  setHint: (text) => setHint(text),
  setCoords: (world) => setCoords(world),
  onZoomChange: (zoom) => setZoomReadout(zoom),
  promptCalibration: async (unit) => {
    const value = await promptModal({
      title: 'Set Scale',
      message: `How many ${unit === 'm' ? 'meters' : 'feet'} does that line span in real life?`,
      defaultValue: unit === 'm' ? '10' : '30',
      okLabel: 'Set Scale',
      inputType: 'number',
    });
    return value === null ? null : Number(value);
  },
});

// ---------------------------------------------------------------------------
// Initial paint
// ---------------------------------------------------------------------------

// Derived UI that should always track the model, no matter which code path
// triggered the change (a tool committing an edit, undo/redo, a fresh import).
model.onChange(() => {
  updateScaleReadout();
  updateSummary();
  updateFileStatus();
  updateMaskStats();
});
updateSummary();
updateFileStatus();
updateScaleReadout();
updateMaskStats();
setZoomReadout(view.zoom);
setTool('select');
