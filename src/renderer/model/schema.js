// Shared constants describing the venue file format (see docs/VENUE_FORMAT.md).
// Kept intentionally simple/data-only so the simulation side of the project
// can consume these files without depending on any editor code.

export const FILE_VERSION = 1;

export const ZONE_TYPES = {
  stage: { label: 'Stage', color: '#e0564f' },
  bar: { label: 'Bar', color: '#4f8fd6' },
  seating: { label: 'Seating', color: '#8b7fe0' },
  restroom: { label: 'Restroom', color: '#5bb98c' },
  merch: { label: 'Merch / Vendor', color: '#d6a24f' },
  'coat-check': { label: 'Coat Check', color: '#4fb0c9' },
  restricted: { label: 'Restricted / Staff Only', color: '#8a8d94' },
  custom: { label: 'Custom Zone', color: '#a0a0a8' },
};

export const POINT_TYPES = {
  entrance: { label: 'Entrance', color: '#5bb98c', glyph: '▲' },
  exit: { label: 'Exit', color: '#d6a24f', glyph: '▼' },
  'emergency-exit': { label: 'Emergency Exit', color: '#e0564f', glyph: '✖' },
  info: { label: 'Info / Box Office', color: '#4f8fd6', glyph: '●' },
  security: { label: 'Security Post', color: '#c94f9a', glyph: '■' },
  custom: { label: 'Custom Point', color: '#a0a0a8', glyph: '●' },
};

export const UNITS = {
  m: { label: 'meters', abbr: 'm' },
  ft: { label: 'feet', abbr: 'ft' },
};

// Per-element flags the designer sets for the optimization side of the
// project: `movable` says whether the optimizer may reposition the element
// at all; `extendable` (walls/zones only — points have no size) says
// whether it may resize/reshape it. Both are pure metadata — the editor
// itself also respects them (a locked element can't be dragged here
// either), but nothing stops a designer from flipping them at any time.
export const DEFAULT_CONSTRAINTS = {
  wall: { movable: false, extendable: false }, // walls default to "permanent structure"
  zone: { movable: true, extendable: true }, // zones default to "optimizer may rearrange"
  point: { movable: false }, // entrances/exits default to "fixed building feature"
};

export function makeId(prefix = 'id') {
  const rand = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8);
  return `${prefix}_${rand}`;
}

/** A brand-new, empty venue. */
export function createEmptyVenue() {
  const now = new Date().toISOString();
  return {
    version: FILE_VERSION,
    meta: {
      name: 'Untitled Venue',
      unit: 'm',
      createdAt: now,
      updatedAt: now,
    },
    // Pixels, at zoom = 1, that represent one real-world unit (meter/foot).
    scale: { pixelsPerUnit: 20 },
    background: null, // { dataUrl, x, y, width, height, opacity }
    walls: [], // { id, points: [{x,y}...], thickness, color }
    zones: [], // { id, type, name, shape, ...shapeFields, color, capacity }
    points: [], // { id, type, name, x, y, flowRate }
  };
}
