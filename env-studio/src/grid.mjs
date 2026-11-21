/**
 * LM-83 sensor grid generator.
 *
 * Fills a floor polygon with sensors using:
 *   - 0.5 m grid spacing
 *   - 0.5 m perimeter offset (sensors must be ≥0.5 m from every wall)
 *   - 0.8 m work-plane height (WPH)
 *
 * Works for any convex or concave polygon footprint.  The algorithm:
 *   1. Build a candidate grid over the bounding box
 *   2. Keep candidates inside the polygon (ray-casting PIP)
 *   3. Discard candidates within `offset` m of any wall segment
 *
 * Returns an array of [x, y, z, dx, dy, dz] sensor records (Radiance format).
 * Sensors face straight up: direction = (0, 0, 1).
 */

export function generateGrid(footprint, _height, {
  spacing = 0.5,
  offset  = 0.5,
  wph     = 0.8,
  zBase   = 0,
} = {}) {
  const xs = footprint.map(v => v[0]);
  const ys = footprint.map(v => v[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  // Inset the grid boundary by exactly `offset` from the bounding box edges.
  // This ensures the first and last row/column are always equidistant from
  // their nearest walls regardless of where the footprint sits in coordinate space.
  const x0 = minX + offset, x1 = maxX - offset;
  const y0 = minY + offset, y1 = maxY - offset;

  if (x1 < x0 - 1e-9 || y1 < y0 - 1e-9) return [];  // room too narrow

  // Count sensors per axis, then distribute evenly between the inset edges.
  // The actual step may differ slightly from `spacing` so that the grid fills
  // edge-to-edge symmetrically — the user-facing spacing is a maximum, not exact.
  // +1e-9 guards against floating-point making 2.0/0.5 = 3.9999... → wrong count.
  const nX = Math.max(1, Math.floor((x1 - x0) / spacing + 1e-9) + 1);
  const nY = Math.max(1, Math.floor((y1 - y0) / spacing + 1e-9) + 1);
  const dX = nX > 1 ? (x1 - x0) / (nX - 1) : 0;
  const dY = nY > 1 ? (y1 - y0) / (nY - 1) : 0;

  const sensors = [];

  for (let ix = 0; ix < nX; ix++) {
    const x = nX === 1 ? (x0 + x1) / 2 : x0 + ix * dX;
    for (let iy = 0; iy < nY; iy++) {
      const y = nY === 1 ? (y0 + y1) / 2 : y0 + iy * dY;
      if (!pointInPolygon(x, y, footprint)) continue;
      if (minDistToWalls(x, y, footprint) < offset - 1e-9) continue;
      sensors.push([round(x), round(y), zBase + wph, 0, 0, 1]);
    }
  }

  return sensors;
}

/**
 * Rotate BTM-space sensor positions into scene (geographic) coordinates.
 *
 * Applies the same clockwise rotation as btmToScene: angle = −trueNorth.
 * Only (x, y) position is rotated; z and direction (dx, dy, dz) are unchanged
 * because sensor normals always point straight up for any horizontal rotation.
 *
 * @param {Array}  sensors    [[x,y,z,dx,dy,dz], …]  from generateGrid (BTM space)
 * @param {number} trueNorth  degrees clockwise from geographic north
 * @param {{x,y}}  centroid   rotation centre (zone.centroid)
 * @returns {Array}  same format, positions in scene/geographic coordinates
 */
export function rotateSensorsToScene(sensors, trueNorth, centroid) {
  const { x: cx, y: cy } = centroid;
  const a   = -trueNorth * Math.PI / 180;  // same sign as btmToScene's rotate2D
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return sensors.map(([x, y, z, dx, dy, dz]) => {
    const rx = x - cx, ry = y - cy;
    return [
      round(rx * cos - ry * sin + cx),
      round(rx * sin + ry * cos + cy),
      z, dx, dy, dz,
    ];
  });
}

/**
 * Sort sensors into the canonical stream order: x ascending, then y ascending
 * — generateGrid's native emission order on a canonical (unrotated) footprint.
 *
 * WHY THIS MATTERS: the ASE pipeline runs ONE rcontrib over the whole sensor
 * stream with a shared fixed-seed LCG (-u-), so the ORDER of sensors is part
 * of the validated configuration — a permuted stream draws a different
 * (equally valid) Monte Carlo subsequence per sensor and can flip borderline
 * ASE sensors across the 250 h threshold. rotateSensorsToScene preserves
 * array order, so any trueNorth ≠ 0 (including 180°, the UI default north-up
 * convention) permutes the stream relative to the validated canonical order.
 * Sorting after rotation restores it. No-op for generateGrid output at tn=0.
 * (sDA is immune: its per-sensor parallel runs reset the seed per sensor.)
 */
export function sortSensorsCanonical(sensors) {
  return [...sensors].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
}

/**
 * Stage 5-C.3: combined sensor stream for a multi-zone (whole-floor) scene.
 * Also serves whole-BUILDING scenes (btmToSceneBuilding/generateBuildingScene,
 * Stage 5-C.7 follow-on): those zone inputs carry an absolute `_zBase`
 * (elevation of the zone's own floor), read below so each zone's sensors
 * land at their real absolute height instead of all at the floor-scene
 * convention of z=0. Floor-scene zone inputs never set `_zBase`, so this
 * is a no-op there (zBase defaults to 0 — unchanged sensor z).
 *
 * Per zone: the zone's custom sensors when present (already in scene coords),
 * otherwise the automatic LM-83 grid generated in BTM coords and rotated
 * about the floor's SHARED anchor (each zone input's `centroid` from
 * btmToSceneFloor IS that anchor). The whole tagged stream is then sorted
 * into the canonical order (x asc, then y asc — same comparator as
 * sortSensorsCanonical): the ASE pipeline runs ONE rcontrib over the entire
 * stream with a shared fixed-seed LCG, so cross-zone sensor ORDER is part of
 * the reproducible configuration exactly as within-zone order is.
 *
 * For a single-zone floor with no custom sensors this reduces to the
 * validated single-zone stream: sortSensorsCanonical(rotateSensorsToScene(
 * generateGrid(...))) — identical sensors, identical order.
 *
 * @returns {{ sensors: Array, zoneIds: string[] }} parallel arrays
 */
export function buildFloorSensorStream(floorScene, { spacing = 0.5, offset = 0.5, wph = 0.8 } = {}) {
  const tagged = [];
  for (const z of floorScene.zones) {
    const sensors = (Array.isArray(z.customSensors) && z.customSensors.length)
      ? z.customSensors
      : rotateSensorsToScene(
          generateGrid(z.btmFootprint ?? z.footprint, z.height, { spacing, offset, wph, zBase: z._zBase ?? 0 }),
          floorScene.trueNorth ?? 0, z.centroid);
    for (const s of sensors) tagged.push([s, z.zoneId]);
  }
  tagged.sort((a, b) => (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]));
  return {
    sensors: tagged.map(t => t[0]),
    zoneIds: tagged.map(t => t[1]),
  };
}

/**
 * Format a sensor array as the Radiance stdin string expected by rcontrib -I.
 * Each sensor: "ox oy oz  dx dy dz\n"
 */
export function sensorsToText(sensors) {
  return sensors.map(([ox, oy, oz, dx, dy, dz]) =>
    `${ox} ${oy} ${oz}  ${dx} ${dy} ${dz}`
  ).join('\n') + '\n';
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function pointInPolygon(px, py, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function minDistToWalls(px, py, polygon) {
  let min = Infinity;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    min = Math.min(min, distToSegment(px, py, polygon[i], polygon[(i + 1) % n]));
  }
  return min;
}

function distToSegment(px, py, [x0, y0], [x1, y1]) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - x0, py - y0);
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function round(v) {
  return Math.round(v * 1e6) / 1e6;  // sub-micron precision, avoids float drift
}
