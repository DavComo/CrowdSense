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

// Zone types that represent an actual physical structure nobody can
// stand on or in — a raised stage platform, a staff-only area — as
// opposed to every other type, which just labels a walkable floor area
// by its purpose (seating/GA floor, a bar counter's service area, a
// restroom, a merch table). Used only by the density simulator, to
// decide which zones to treat as obstacles like a wall (see
// docs/DENSITY_SIMULATION.md) — not by the walkability/mask panel, which
// keeps its own "zones never block" convention (docs/MASKS.md).
export const ZONE_BLOCKING_TYPES = new Set(['stage', 'restricted']);

// Points are only ever an entrance or an exit — that's the only distinction
// the entrance/exit-rate mask cares about (sign: positive for entrance,
// negative for exit).
export const POINT_TYPES = {
  entrance: { label: 'Entrance', color: '#5bb98c', glyph: '▲' },
  exit: { label: 'Exit', color: '#d6a24f', glyph: '▼' },
};

export const UNITS = {
  m: { label: 'meters', abbr: 'm' },
  ft: { label: 'feet', abbr: 'ft' },
};

// `movable`/`extendable` say what the optimizer is allowed to touch — the
// editor itself also respects them (a locked wall can't be dragged/resized
// here either). Walls are the only thing that carries these: they're what
// the barrier mask (docs/MASKS.md) is built from, so they're the only
// element type where the distinction actually feeds a mask. Zones and
// points dropped these fields for the same reason they dropped every other
// property that isn't aesthetic or mask-facing.
export const DEFAULT_CONSTRAINTS = {
  wall: { movable: false, extendable: false }, // walls default to "permanent structure"
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
    walls: [], // { id, shape, ...shapeFields, thickness?, color, rotation?, movable, extendable }
    zones: [], // { id, type, name, shape, ...shapeFields, color, attraction, rotation? }
    points: [], // { id, type: 'entrance'|'exit', name, x, y, color, throughput }
  };
}
