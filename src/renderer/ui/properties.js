import { ZONE_TYPES, POINT_TYPES, isZoneWalkable } from '../model/schema.js';
import { zoneArea } from '../canvas/geometry.js';
import { distance } from '../canvas/geometry.js';

const WALL_SHAPE_LABELS = {
  line: 'Line wall',
  pillar: 'Pillar (round obstacle)',
  rect: 'Rectangular obstacle',
};

function wallLength(wall) {
  let total = 0;
  for (let i = 0; i < wall.points.length - 1; i++) total += distance(wall.points[i], wall.points[i + 1]);
  return total;
}

function row(labelText, inputEl) {
  const wrap = document.createElement('div');
  wrap.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.append(label, inputEl);
  return wrap;
}

function textInput(value, onInput) {
  const el = document.createElement('input');
  el.type = 'text';
  el.value = value ?? '';
  el.addEventListener('input', () => onInput(el.value));
  return el;
}

function numberInput(value, onInput, { min, step = 0.1, allowNull = false, placeholder } = {}) {
  const el = document.createElement('input');
  el.type = 'number';
  if (step != null) el.step = String(step);
  if (min != null) el.min = String(min);
  if (placeholder) el.placeholder = placeholder;
  el.value = value ?? '';
  el.addEventListener('input', () => {
    if (el.value === '') { onInput(allowNull ? null : 0); return; }
    onInput(Number(el.value));
  });
  return el;
}

function selectInput(options, value, onChange) {
  const el = document.createElement('select');
  for (const [key, def] of Object.entries(options)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = def.label;
    if (key === value) opt.selected = true;
    el.appendChild(opt);
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function colorInput(value, onChange) {
  const el = document.createElement('input');
  el.type = 'color';
  el.value = value;
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

function checkboxInput(checked, onChange) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = checked;
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

/** "Optimization constraints" rows: whether the layout optimizer is allowed
 * to move and/or resize this element. Walls only — points don't carry
 * these (a point's position isn't independent, see docs/VENUE_FORMAT.md);
 * zones get their own tri-state version below (movementSelectInput) since
 * "resize without ever moving" isn't a state worth exposing separately for
 * furniture-like zones the way it is for a wall. */
function constraintRows(container, item, commitAnd, { includeExtendable }) {
  const hint = document.createElement('p');
  hint.style.cssText = 'margin:2px 0 8px;color:var(--text-dim);font-size:11px;';
  hint.textContent = 'Controls what the crowd-flow optimizer is allowed to adjust — not the editor.';
  container.appendChild(hint);

  container.appendChild(row('Movable', checkboxInput(item.movable !== false, (v) => commitAnd(() => { item.movable = v; }))));
  if (includeExtendable) {
    container.appendChild(row('Extendable', checkboxInput(item.extendable !== false, (v) => commitAnd(() => { item.extendable = v; }))));
  }
}

const ZONE_MOVE_OPTIONS = {
  fixed: { label: 'Fixed — optimizer may not touch it' },
  move: { label: 'Can move' },
  reshape: { label: 'Can move & reshape' },
};

/** Zones fold `movable`/`extendable` into one tri-state choice — "fixed",
 * "can move", or "can move & reshape" — rather than two checkboxes: an
 * `extendable: true` with `movable: false` isn't a state the optimizer or
 * this schema treats as different from "extendable: false" (arena.py's
 * build_spec only reads `extendable` at all once `movable` is true), so
 * exposing it as an independent checkbox would just invite a combination
 * that quietly does nothing. */
function zoneConstraintRow(container, item, commitAnd) {
  const hint = document.createElement('p');
  hint.style.cssText = 'margin:2px 0 8px;color:var(--text-dim);font-size:11px;';
  hint.textContent = 'Controls what the crowd-flow optimizer is allowed to adjust — not the editor.';
  container.appendChild(hint);

  const movable = item.movable !== false;
  const extendable = item.extendable !== false;
  const current = !movable ? 'fixed' : (extendable ? 'reshape' : 'move');
  container.appendChild(row('Optimizer may', selectInput(ZONE_MOVE_OPTIONS, current, (v) => commitAnd(() => {
    item.movable = v !== 'fixed';
    item.extendable = v === 'reshape';
  }))));
}

function readonlyRow(labelText, valueText) {
  const wrap = document.createElement('div');
  wrap.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = labelText;
  const val = document.createElement('span');
  val.textContent = valueText;
  val.style.color = 'var(--text)';
  val.style.fontVariantNumeric = 'tabular-nums';
  wrap.append(label, val);
  return wrap;
}

/** Renders the properties panel for the current selection. */
export function renderProperties(container, model, selection, callbacks) {
  container.innerHTML = '';

  if (!selection) {
    container.classList.add('empty');
    container.textContent = 'Nothing selected';
    return;
  }
  container.classList.remove('empty');

  const item = model.find(`${selection.kind}s`, selection.id);
  if (!item) {
    container.classList.add('empty');
    container.textContent = 'Nothing selected';
    return;
  }

  const unit = model.venue.meta.unit;
  const commitAnd = (mutate) => {
    mutate();
    model.commit();
    callbacks.onChange();
  };

  if (selection.kind === 'zone') {
    container.appendChild(row('Name', textInput(item.name, (v) => commitAnd(() => { item.name = v; }))));
    container.appendChild(row('Type', selectInput(ZONE_TYPES, item.type, (v) => commitAnd(() => {
      item.type = v;
      item.color = ZONE_TYPES[v].color;
    }))));
    container.appendChild(row('Color', colorInput(item.color || (ZONE_TYPES[item.type] ?? ZONE_TYPES.custom).color, (v) => commitAnd(() => { item.color = v; }))));
    if (item.shape === 'rect') {
      container.appendChild(row('Rotation (°)', numberInput(item.rotation ?? 0, (v) => commitAnd(() => { item.rotation = v; }), { step: 1 })));
    }
    container.appendChild(row('Attraction', checkboxInput(Boolean(item.attraction), (v) => commitAnd(() => { item.attraction = v; }))));
    container.appendChild(row('Walkable', checkboxInput(isZoneWalkable(item), (v) => commitAnd(() => { item.walkable = v; }))));
    container.appendChild(readonlyRow('Area', `${zoneArea(item).toFixed(1)} ${unit}²`));
    zoneConstraintRow(container, item, commitAnd);
  } else if (selection.kind === 'wall') {
    const shape = item.shape ?? 'line';
    container.appendChild(readonlyRow('Shape', WALL_SHAPE_LABELS[shape] ?? WALL_SHAPE_LABELS.line));
    if (shape === 'pillar') {
      container.appendChild(row('Radius', numberInput(item.r, (v) => commitAnd(() => { item.r = Math.max(0.05, v); }), { min: 0.05, step: 0.05 })));
      container.appendChild(row('Color', colorInput(item.color || '#c9cbd4', (v) => commitAnd(() => { item.color = v; }))));
      container.appendChild(readonlyRow('Footprint', `${(Math.PI * item.r * item.r).toFixed(2)} ${unit}²`));
    } else if (shape === 'rect') {
      container.appendChild(row('Color', colorInput(item.color || '#c9cbd4', (v) => commitAnd(() => { item.color = v; }))));
      container.appendChild(row('Rotation (°)', numberInput(item.rotation ?? 0, (v) => commitAnd(() => { item.rotation = v; }), { step: 1 })));
      container.appendChild(readonlyRow('Footprint', `${(Math.abs(item.w) * Math.abs(item.h)).toFixed(2)} ${unit}²`));
    } else {
      container.appendChild(row('Thickness', numberInput(item.thickness, (v) => commitAnd(() => { item.thickness = Math.max(0.02, v); }), { min: 0.02, step: 0.05 })));
      container.appendChild(row('Color', colorInput(item.color || '#c9cbd4', (v) => commitAnd(() => { item.color = v; }))));
      container.appendChild(readonlyRow('Length', `${wallLength(item).toFixed(2)} ${unit}`));
      container.appendChild(readonlyRow('Segments', String(item.points.length - 1)));
    }
    constraintRows(container, item, commitAnd, { includeExtendable: true });
  } else if (selection.kind === 'point') {
    container.appendChild(row('Name', textInput(item.name, (v) => commitAnd(() => { item.name = v; }))));
    container.appendChild(row('Type', selectInput(POINT_TYPES, item.type, (v) => commitAnd(() => {
      item.type = v;
      item.color = POINT_TYPES[v].color;
    }))));
    container.appendChild(row('Color', colorInput(item.color || (POINT_TYPES[item.type] ?? POINT_TYPES.entrance).color, (v) => commitAnd(() => { item.color = v; }))));
    container.appendChild(row('Throughput (people/min)', numberInput(item.throughput, (v) => commitAnd(() => { item.throughput = v; }), { min: 0, step: 1, allowNull: true, placeholder: 'not set' })));
    container.appendChild(readonlyRow('Position', `${item.x.toFixed(2)}, ${item.y.toFixed(2)} ${unit}`));
  }

  const del = document.createElement('button');
  del.className = 'prop-delete';
  del.textContent = 'Delete';
  del.addEventListener('click', () => callbacks.onDelete(selection));
  container.appendChild(del);
}
