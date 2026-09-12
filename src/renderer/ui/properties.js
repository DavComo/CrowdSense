import { ZONE_TYPES, POINT_TYPES } from '../model/schema.js';
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

/** Shared "optimization constraints" rows: whether the layout optimizer is
 * allowed to move and/or resize this element. `extendable` is omitted for
 * point markers — they have no size to extend. */
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
    container.appendChild(row('Capacity (people)', numberInput(item.capacity, (v) => commitAnd(() => { item.capacity = v; }), { min: 0, step: 1, allowNull: true, placeholder: 'not set' })));
    container.appendChild(row('Stickiness (avg. dwell, min)', numberInput(item.stickiness, (v) => commitAnd(() => { item.stickiness = v; }), { min: 0, step: 0.5, allowNull: true, placeholder: 'not set' })));
    container.appendChild(readonlyRow('Area', `${zoneArea(item).toFixed(1)} ${unit}²`));
    constraintRows(container, item, commitAnd, { includeExtendable: true });
  } else if (selection.kind === 'wall') {
    const shape = item.shape ?? 'line';
    container.appendChild(readonlyRow('Shape', WALL_SHAPE_LABELS[shape] ?? WALL_SHAPE_LABELS.line));
    if (shape === 'pillar') {
      container.appendChild(row('Radius', numberInput(item.r, (v) => commitAnd(() => { item.r = Math.max(0.05, v); }), { min: 0.05, step: 0.05 })));
      container.appendChild(row('Color', colorInput(item.color || '#c9cbd4', (v) => commitAnd(() => { item.color = v; }))));
      container.appendChild(readonlyRow('Footprint', `${(Math.PI * item.r * item.r).toFixed(2)} ${unit}²`));
    } else if (shape === 'rect') {
      container.appendChild(row('Color', colorInput(item.color || '#c9cbd4', (v) => commitAnd(() => { item.color = v; }))));
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
    container.appendChild(row('Color', colorInput(item.color || (POINT_TYPES[item.type] ?? POINT_TYPES.custom).color, (v) => commitAnd(() => { item.color = v; }))));
    container.appendChild(row('Flow rate (people/min)', numberInput(item.flowRate, (v) => commitAnd(() => { item.flowRate = v; }), { min: 0, step: 1, allowNull: true, placeholder: 'not set' })));
    container.appendChild(readonlyRow('Position', `${item.x.toFixed(2)}, ${item.y.toFixed(2)} ${unit}`));
    constraintRows(container, item, commitAnd, { includeExtendable: false });
  }

  const del = document.createElement('button');
  del.className = 'prop-delete';
  del.textContent = 'Delete';
  del.addEventListener('click', () => callbacks.onDelete(selection));
  container.appendChild(del);
}
