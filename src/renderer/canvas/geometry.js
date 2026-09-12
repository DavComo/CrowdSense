// Small geometry helpers shared by rendering and hit-testing.

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
