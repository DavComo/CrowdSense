import { createEmptyVenue, DEFAULT_CONSTRAINTS, FILE_VERSION } from './schema.js';

const MAX_HISTORY = 100;

/**
 * Holds the current venue document plus undo/redo history.
 * State is treated as immutable-by-convention: call `commit()` after
 * mutating `venue` in place to snapshot it onto the history stack.
 */
export class VenueModel {
  constructor() {
    this.venue = createEmptyVenue();
    this.filePath = null;
    this.dirty = false;

    this._undoStack = [];
    this._redoStack = [];
    this._listeners = new Set();

    // Baseline snapshot so the first real edit has something to diff against.
    this._pushHistory(this._undoStack);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify() {
    for (const fn of this._listeners) fn(this.venue);
  }

  _snapshot() {
    return JSON.stringify(this.venue);
  }

  _pushHistory(stack) {
    stack.push(this._snapshot());
    if (stack.length > MAX_HISTORY) stack.shift();
  }

  /** Call after mutating `this.venue` in place. */
  commit() {
    this.venue.meta.updatedAt = new Date().toISOString();
    this.dirty = true;
    this._pushHistory(this._undoStack);
    this._redoStack.length = 0;
    this._notify();
  }

  /** Silent notify with no history entry — for transient UI state like hover. */
  touch() {
    this._notify();
  }

  undo() {
    if (this._undoStack.length <= 1) return false;
    this._redoStack.push(this._undoStack.pop());
    const prev = this._undoStack[this._undoStack.length - 1];
    this.venue = JSON.parse(prev);
    this.dirty = true;
    this._notify();
    return true;
  }

  redo() {
    if (this._redoStack.length === 0) return false;
    const next = this._redoStack.pop();
    this._undoStack.push(next);
    this.venue = JSON.parse(next);
    this.dirty = true;
    this._notify();
    return true;
  }

  reset(newVenue) {
    this.venue = newVenue ?? createEmptyVenue();
    this.filePath = null;
    this.dirty = false;
    this._undoStack = [];
    this._redoStack = [];
    this._pushHistory(this._undoStack);
    this._notify();
  }

  loadFromJSON(jsonText, filePath) {
    const parsed = JSON.parse(jsonText);
    const venue = migrateVenue(parsed);
    this.venue = venue;
    this.filePath = filePath ?? null;
    this.dirty = false;
    this._undoStack = [];
    this._redoStack = [];
    this._pushHistory(this._undoStack);
    this._notify();
  }

  toJSON() {
    return JSON.stringify(this.venue, null, 2);
  }

  markSaved(filePath) {
    this.filePath = filePath ?? this.filePath;
    this.dirty = false;
  }

  // --- Derived helpers -----------------------------------------------------

  find(kind, id) {
    return this.venue[kind]?.find((item) => item.id === id) ?? null;
  }

  removeById(kind, id) {
    const list = this.venue[kind];
    const idx = list.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }
}

/** Very small forward-compat shim; bump FILE_VERSION and add cases as the
 * format evolves so old save files keep loading. */
function migrateVenue(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('Not a valid venue file.');
  if (doc.version === undefined) {
    throw new Error('File is missing a version field — not a CrowdSense venue file.');
  }
  if (doc.version > FILE_VERSION) {
    throw new Error(`This file was saved by a newer version of CrowdSense (v${doc.version}).`);
  }

  const base = createEmptyVenue();
  return {
    ...base,
    ...doc,
    meta: { ...base.meta, ...doc.meta },
    scale: { ...base.scale, ...doc.scale },
    // Files saved before a field existed (or hand-edited ones missing one)
    // get the same defaults a freshly-drawn element would, so the rest of
    // the app can always rely on every field being present: movable/
    // extendable, a wall's `shape` (every wall used to just be a line), and
    // a zone's `stickiness`.
    walls: (doc.walls ?? []).map((w) => ({ shape: 'line', ...DEFAULT_CONSTRAINTS.wall, ...w })),
    zones: (doc.zones ?? []).map((z) => ({ stickiness: null, ...DEFAULT_CONSTRAINTS.zone, ...z })),
    points: (doc.points ?? []).map((p) => ({ ...DEFAULT_CONSTRAINTS.point, ...p })),
    version: FILE_VERSION,
  };
}
