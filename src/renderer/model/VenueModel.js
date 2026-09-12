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
    walls: (doc.walls ?? []).map(migrateWall),
    zones: (doc.zones ?? []).map(migrateZone),
    points: (doc.points ?? []).map(migratePoint).filter(Boolean),
    version: FILE_VERSION,
  };
}

/** Walls: backfill `shape` (every wall used to just be a line) and the
 * movable/extendable defaults, and give rect walls a `rotation` if an
 * older file predates that field. */
function migrateWall(w) {
  const wall = { shape: 'line', ...DEFAULT_CONSTRAINTS.wall, ...w };
  if (wall.shape === 'rect' && wall.rotation === undefined) wall.rotation = 0;
  return wall;
}

/** Zones dropped every property that isn't aesthetic or mask-facing:
 * `capacity`/`stickiness`/`movable`/`extendable` are stripped outright
 * (not just left un-rendered) rather than carried forward as orphaned
 * dead data with no UI to edit them. `attraction` used to be a 0–10
 * number; it's boolean now, so an old numeric value becomes `true` if it
 * was positive. Rect zones get a `rotation` if the file predates it. */
function migrateZone(z) {
  const { capacity, stickiness, movable, extendable, attraction, ...rest } = z;
  const zone = {
    ...rest,
    attraction: typeof attraction === 'number' ? attraction > 0 : Boolean(attraction),
  };
  if (zone.shape === 'rect' && zone.rotation === undefined) zone.rotation = 0;
  return zone;
}

/** Points are entrance/exit only now. `emergency-exit` collapses into
 * `exit` (same sign in the entrance/exit-rate mask); any other old type
 * (info/security/custom) has no valid representation left, so those
 * points are dropped rather than silently mislabeled as an entrance or
 * exit they never were. `movable` is stripped for the same reason as the
 * zone constraint fields above. Also migrates the old `flowRate` field
 * name to `throughput`. Returns null for a point that should be dropped. */
function migratePoint(p) {
  const { flowRate, movable, ...rest } = p;
  let type = p.type;
  if (type === 'emergency-exit') type = 'exit';
  else if (type !== 'entrance' && type !== 'exit') return null;
  return { throughput: flowRate ?? null, ...rest, type };
}
