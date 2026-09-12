// Small geometry helpers shared by rendering and hit-testing.

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Wraps a radian angle difference into (-π, π] — the "shortest way to
 * turn" from one direction to another, in either rotational sense. */
export function normalizeAngleDiff(diff) {
  diff = diff % (2 * Math.PI);
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (diff <= -Math.PI) diff += 2 * Math.PI;
  return diff;
}

export function pointToSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return distance(p, proj);
}

export function pointInRect(p, x, y, w, h) {
  const minX = Math.min(x, x + w);
  const maxX = Math.max(x, x + w);
  const minY = Math.min(y, y + h);
  const maxY = Math.max(y, y + h);
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}

export function pointInPolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

export function rectBounds(zone) {
  return {
    x: Math.min(zone.x, zone.x + zone.w),
    y: Math.min(zone.y, zone.y + zone.h),
    w: Math.abs(zone.w),
    h: Math.abs(zone.h),
  };
}

/** Rotates a point around `center` by `angleRad` (radians, standard math
 * convention — positive turns from +x toward +y, i.e. clockwise since y
 * is down). Shared by rendering, hit-testing, and mask rasterization so a
 * rotated rect means the same thing everywhere. */
export function rotatePoint(p, center, angleRad) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export function rectCenter(rect) {
  const b = rectBounds(rect);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** A rect's four corners in world space, honoring `rect.rotation` (degrees,
 * default 0) — for rendering and drag-handle positions. Order: the four
 * corners of the unrotated rect, each rotated around its center. */
export function rotatedRectCorners(rect) {
  const b = rectBounds(rect);
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const angleRad = ((rect.rotation ?? 0) * Math.PI) / 180;
  const local = [
    { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
  ];
  return local.map((p) => rotatePoint(p, center, angleRad));
}

/** Whether a world point falls inside a (possibly rotated) rect — rotates
 * the point back into the rect's local, unrotated frame first, then does a
 * plain axis-aligned test. Used for both hit-testing and mask
 * rasterization, so a tilted wall/zone blocks/marks exactly where it's
 * actually drawn. */
export function pointInRotatedRect(p, rect) {
  const b = rectBounds(rect);
  if (!rect.rotation) return pointInRect(p, b.x, b.y, b.w, b.h);
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const angleRad = ((rect.rotation ?? 0) * Math.PI) / 180;
  const local = rotatePoint(p, center, -angleRad);
  return pointInRect(local, b.x, b.y, b.w, b.h);
}

/** Axis-aligned bounding box of a (possibly rotated) rect's actual
 * corners — for content bounds / mask grid sizing, where the plain
 * unrotated x/y/w/h would understate a tilted rect's true footprint. */
export function rotatedRectBoundingBox(rect) {
  const corners = rotatedRectCorners(rect);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Real-world area (square units) of a zone, given its shape fields. */
export function zoneArea(zone) {
  if (zone.shape === 'rect') {
    const b = rectBounds(zone);
    return b.w * b.h;
  }
  if (zone.shape === 'circle') {
    return Math.PI * zone.r * zone.r;
  }
  if (zone.shape === 'polygon') {
    return polygonArea(zone.points);
  }
  return 0;
}
