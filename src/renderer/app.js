import { VenueModel } from './model/VenueModel.js';
import { CanvasView } from './canvas/CanvasView.js';
import { InputController } from './canvas/InputController.js';
import { renderProperties } from './ui/properties.js';
import { zoneArea } from './canvas/geometry.js';
import { promptModal, confirmModal } from './ui/modal.js';

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
  if (!view.selection) return;
  model.removeById(`${view.selection.kind}s`, view.selection.id);
  model.commit();
  view.selection = null;
  renderPropertiesPanel(null);
  view.render();
  updateSummary();
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && view.selection) {
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
    await window.crowdsense.writeFile(model.filePath, contents);
    model.markSaved(model.filePath);
    updateFileStatus();
    return;
  }
  const defaultPath = `${(model.venue.meta.name || 'venue').replace(/[^\w\- ]/g, '')}.crowdsense.json`;
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
});
updateSummary();
updateFileStatus();
updateScaleReadout();
setZoomReadout(view.zoom);
setTool('select');
