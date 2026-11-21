import {
  buildPitchedRoofGeometry,
  clipPolygonToTriangle2D,
  planeZAtPoint,
} from './pitched-roof-geometry.mjs?v=straight-skeleton-hip-20260731';

const EPS = 1e-8;
const DEG = Math.PI / 180;

export const SOLAR_PALETTE = Object.freeze([
  Object.freeze({ t: 0.00, hex: '#3A00C4' }),
  Object.freeze({ t: 0.50, hex: '#FD0E01' }),
  Object.freeze({ t: 1.00, hex: '#FDEE01' }),
]);

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = a => Math.hypot(a.x, a.y, a.z);
const unit = a => { const d = length(a); return d > EPS ? mul(a, 1 / d) : { x: 0, y: 0, z: 0 }; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function newellNormal(poly) {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  return unit({ x, y, z });
}

function polygonCentroid(poly) {
  return poly.reduce((sum, p) => add(sum, mul(p, 1 / poly.length)), { x: 0, y: 0, z: 0 });
}

function polygonArea3D(poly) {
  if (poly.length < 3) return 0;
  const o = poly[0];
  let area = 0;
  for (let i = 1; i < poly.length - 1; i++) area += length(cross(sub(poly[i], o), sub(poly[i + 1], o))) / 2;
  return area;
}

function pointSegmentDistance3D(point, a, b) {
  const edge = sub(b, a);
  const denom = dot(edge, edge);
  const t = denom > EPS ? clamp(dot(sub(point, a), edge) / denom, 0, 1) : 0;
  return length(sub(point, add(a, mul(edge, t))));
}

function polygonEdgeClearance(point, polygons) {
  let distance = Infinity;
  for (const polygon of polygons) {
    for (let i = 0; i < polygon.length; i++) {
      distance = Math.min(distance, pointSegmentDistance3D(point, polygon[i], polygon[(i + 1) % polygon.length]));
    }
  }
  return distance;
}

function signedArea2D(poly) {
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  return area2 / 2;
}

function pointInPolygon2D(point, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > point.y) !== (b.y > point.y)) &&
        point.x < (b.x - a.x) * (point.y - a.y) / ((b.y - a.y) || EPS) + a.x) inside = !inside;
  }
  return inside;
}

function triangulate2D(poly) {
  if (poly.length < 3) return [];
  const ccw = signedArea2D(poly) >= 0;
  const remaining = poly.map((_, i) => i);
  const triangles = [];
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inTri = (p, a, b, c) => {
    const d1 = orient(p, a, b), d2 = orient(p, b, c), d3 = orient(p, c, a);
    return !((d1 < -EPS || d2 < -EPS || d3 < -EPS) && (d1 > EPS || d2 > EPS || d3 > EPS));
  };
  let guard = poly.length * poly.length;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let ri = 0; ri < remaining.length; ri++) {
      const ia = remaining[(ri - 1 + remaining.length) % remaining.length];
      const ib = remaining[ri];
      const ic = remaining[(ri + 1) % remaining.length];
      const turn = orient(poly[ia], poly[ib], poly[ic]);
      if ((ccw && turn <= EPS) || (!ccw && turn >= -EPS)) continue;
      if (remaining.some(idx => idx !== ia && idx !== ib && idx !== ic && inTri(poly[idx], poly[ia], poly[ib], poly[ic]))) continue;
      triangles.push([poly[ia], poly[ib], poly[ic]]);
      remaining.splice(ri, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (remaining.length === 3) triangles.push(remaining.map(i => poly[i]));
  if (!triangles.length) for (let i = 1; i < poly.length - 1; i++) triangles.push([poly[0], poly[i], poly[i + 1]]);
  return triangles;
}

function clipPolygonAxis(poly, axis, limit, keepGreater) {
  const out = [];
  if (!poly.length) return out;
  const value = p => p[axis];
  const inside = p => keepGreater ? value(p) >= limit - EPS : value(p) <= limit + EPS;
  let a = poly.at(-1), aInside = inside(a);
  for (const b of poly) {
    const bInside = inside(b);
    if (aInside !== bInside) {
      const denom = value(b) - value(a);
      const t = Math.abs(denom) > EPS ? (limit - value(a)) / denom : 0;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    if (bInside) out.push({ ...b });
    a = b; aInside = bInside;
  }
  return out;
}

function clipToRect(poly, x0, y0, x1, y1) {
  return clipPolygonAxis(
    clipPolygonAxis(
      clipPolygonAxis(
        clipPolygonAxis(poly, 'x', x0, true), 'x', x1, false),
      'y', y0, true),
    'y', y1, false);
}

function planeBasis(poly, preferredNormal = null) {
  let n = newellNormal(poly);
  if (preferredNormal && length(preferredNormal) > EPS && dot(n, preferredNormal) < 0) n = mul(n, -1);
  let best = sub(poly[1], poly[0]);
  for (let i = 1; i < poly.length; i++) {
    const edge = sub(poly[(i + 1) % poly.length], poly[i]);
    if (length(edge) > length(best)) best = edge;
  }
  const u = unit(sub(best, mul(n, dot(best, n))));
  const v = unit(cross(n, u));
  const origin = poly[0];
  return { origin, u, v, n };
}

function projectPoint(p, basis) {
  const d = sub(p, basis.origin);
  return { x: dot(d, basis.u), y: dot(d, basis.v) };
}

function liftPoint(p, basis) {
  return add(basis.origin, add(mul(basis.u, p.x), mul(basis.v, p.y)));
}

function polygonPointInside3D(point, polygon) {
  const basis = planeBasis(polygon);
  return pointInPolygon2D(projectPoint(point, basis), polygon.map(p => projectPoint(p, basis)));
}

function gridPolygon3D(poly, spacing, holes = [], preferredNormal = null) {
  if (!poly || poly.length < 3) return [];
  const basis = planeBasis(poly, preferredNormal);
  const outer = poly.map(p => projectPoint(p, basis));
  const projectedHoles = holes.filter(h => h?.length >= 3).map(h => h.map(p => projectPoint(p, basis)));
  const triangles = triangulate2D(outer);
  const minX = Math.min(...outer.map(p => p.x)), maxX = Math.max(...outer.map(p => p.x));
  const minY = Math.min(...outer.map(p => p.y)), maxY = Math.max(...outer.map(p => p.y));
  const step = Math.max(0.1, spacing || 1);
  const xStart = Math.floor(minX / step) * step;
  const yStart = Math.floor(minY / step) * step;
  const cells = [];
  for (let x = xStart; x < maxX - EPS; x += step) {
    for (let y = yStart; y < maxY - EPS; y += step) {
      const fragments = [];
      for (const triangle of triangles) {
        const clipped = clipToRect(triangle, x, y, Math.min(x + step, maxX), Math.min(y + step, maxY));
        if (clipped.length < 3 || Math.abs(signedArea2D(clipped)) < 1e-7) continue;
        const centroid2D = clipped.reduce((s, p) => ({ x: s.x + p.x / clipped.length, y: s.y + p.y / clipped.length }), { x: 0, y: 0 });
        if (projectedHoles.some(h => pointInPolygon2D(centroid2D, h))) continue;
        const vertices = clipped.map(p => liftPoint(p, basis));
        const areaM2 = polygonArea3D(vertices);
        if (areaM2 > EPS) fragments.push({ vertices, centroid2D, areaM2 });
      }
      if (!fragments.length) continue;

      // The host polygon is triangulated only to make clipping easy. A grid
      // square crossing an internal triangulation edge must still be one
      // analysis cell; treating its clipped halves as independent sensors
      // creates false diagonal bands and lets PV area caps rank the halves
      // separately. Keep every fragment for rendering, but use one sample,
      // one area, and one result value for the complete logical grid cell.
      const areaM2 = fragments.reduce((sum, fragment) => sum + fragment.areaM2, 0);
      const center2D = {
        x: (x + Math.min(x + step, maxX)) / 2,
        y: (y + Math.min(y + step, maxY)) / 2,
      };
      const centerIsUsable = pointInPolygon2D(center2D, outer)
        && !projectedHoles.some(h => pointInPolygon2D(center2D, h));
      const largest = fragments.reduce((best, fragment) => fragment.areaM2 > best.areaM2 ? fragment : best);
      const sample2D = centerIsUsable ? center2D : largest.centroid2D;
      cells.push({
        vertices: largest.vertices,
        renderPolygons: fragments.map(fragment => fragment.vertices),
        centroid: liftPoint(sample2D, basis),
        areaM2,
        normal: basis.n,
      });
    }
  }
  return cells;
}

function rotatePlanVector(vector, degrees) {
  const a = degrees * DEG, c = Math.cos(a), s = Math.sin(a);
  return { x: vector.x * c - vector.y * s, y: vector.x * s + vector.y * c, z: vector.z };
}

export function orientationFromNormal(normal, trueNorth = 0) {
  const world = rotatePlanVector(unit(normal), -trueNorth);
  const tiltDeg = Math.acos(clamp(world.z, -1, 1)) / DEG;
  if (tiltDeg <= 10) return { orientation: 'Horizontal', azimuthDeg: null, tiltDeg };
  if (tiltDeg >= 170) return { orientation: 'Down', azimuthDeg: null, tiltDeg };
  const azimuthDeg = ((Math.atan2(world.x, world.y) / DEG) % 360 + 360) % 360;
  const orientation = azimuthDeg >= 315 || azimuthDeg < 45 ? 'N'
    : azimuthDeg < 135 ? 'E' : azimuthDeg < 225 ? 'S' : 'W';
  return { orientation, azimuthDeg, tiltDeg };
}

function parseLocationLine(line) {
  const p = String(line || '').split(',');
  if (p[0] !== 'LOCATION') return null;
  return { name: [p[1], p[3], p[4]].filter(Boolean).join(' '), latitude: +p[6], longitude: +p[7], timeZone: +p[8], elevation: +p[9] };
}

function dayOfYear(month, day) {
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return cumulative[month - 1] + day;
}

export function solarPosition({ latitude, longitude, timeZone, month, day, hour }) {
  const n = dayOfYear(month, day);
  const gamma = 2 * Math.PI / 365 * (n - 1 + (hour - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const solarMinutes = hour * 60 + eqtime + 4 * longitude - 60 * timeZone;
  const hourAngle = (solarMinutes / 4 - 180) * DEG;
  const lat = latitude * DEG;
  const vector = unit({
    x: -Math.cos(decl) * Math.sin(hourAngle),
    y: Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(hourAngle),
    z: Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle),
  });
  return { vector, altitudeDeg: Math.asin(clamp(vector.z, -1, 1)) / DEG };
}

export function parseEpwSolarData(input, fallbackLocation = null) {
  const text = typeof input === 'string' ? input
    : new TextDecoder().decode(input instanceof ArrayBuffer ? new Uint8Array(input) : input);
  const lines = text.split(/\r?\n/);
  const location = parseLocationLine(lines[0]) || fallbackLocation;
  if (!location || !Number.isFinite(location.latitude)) throw new Error('Solar analysis requires a valid EPW LOCATION header');
  const hours = [];
  for (let i = 8; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 22) continue;
    const month = +p[1], day = +p[2], epwHour = +p[3];
    const ghi = Math.max(0, +p[13] || 0), dni = Math.max(0, +p[14] || 0), dhi = Math.max(0, +p[15] || 0);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && epwHour >= 1 && epwHour <= 24)) continue;
    const hour = epwHour - 0.5;
    const sun = solarPosition({ ...location, month, day, hour });
    hours.push({ month, day, hour, ghi, dni, dhi, sun: sun.vector });
  }
  if (!hours.length) throw new Error('EPW contains no usable hourly solar records');
  return { location, hours };
}

function surfacePolygon(surf) {
  if (surf.vertices3d?.length >= 3) return surf.vertices3d.map(p => ({ x: +p.x, y: +p.y, z: +p.z }));
  if (surf.type === 'Wall') {
    const z0 = +(surf.zBase || 0), z1 = z0 + +(surf.height || 0);
    return [
      { x: surf.p1.x, y: surf.p1.y, z: z1 },
      { x: surf.p1.x, y: surf.p1.y, z: z0 },
      { x: surf.p2.x, y: surf.p2.y, z: z0 },
      { x: surf.p2.x, y: surf.p2.y, z: z1 },
    ];
  }
  const z = +(surf.z ?? (surf.type === 'Floor' ? surf.zBase || 0 : (surf.zBase || 0) + (surf.height || 0)));
  const ring = surf.type === 'Floor' ? [...(surf.footprint || [])].reverse() : (surf.footprint || []);
  return ring.map(p => ({ x: p.x, y: p.y, z }));
}

function wallOpeningPolygon(surf, opening) {
  const z0 = +(surf.zBase || 0) + +(opening.z0 || 0), z1 = z0 + +(opening.height || 0);
  return [
    { x: opening.x1, y: opening.y1, z: z1 },
    { x: opening.x1, y: opening.y1, z: z0 },
    { x: opening.x2, y: opening.y2, z: z0 },
    { x: opening.x2, y: opening.y2, z: z1 },
  ];
}

function openingSolarT(opening, fallback) {
  const explicit = opening?.solarTransmittance;
  if (explicit !== null && explicit !== undefined && explicit !== '' && Number.isFinite(+explicit)) {
    return clamp(+explicit, 0, 1);
  }
  const inherited = +fallback;
  return clamp(Number.isFinite(inherited) ? inherited : 0.35, 0, 1);
}

function roofEntries(surf) {
  if (surf.type !== 'RoofCeiling' || surf.roof?.type === 'flat' || !surf.roof?.type || !(+surf.roof.ridgeHeight > 0)) {
    return [{ id: surf.id, sourceId: surf.id, polygon: surfacePolygon(surf), surface: surf, skylights: surf.skylights || [] }];
  }
  const built = buildPitchedRoofGeometry(surf);
  return built.roofTriangles.map((triangle, index) => ({
    id: `${surf.id}:facet:${String(index + 1).padStart(2, '0')}`,
    sourceId: surf.id,
    polygon: triangle.map(p => ({ ...p })),
    surface: surf,
    roofTriangle: triangle,
    skylights: (surf.skylights || []).flatMap(sk => {
      if (sk.isVoid) return [];
      const clipped = clipPolygonToTriangle2D(sk.pts || [], triangle);
      return clipped.length >= 3 ? [{ ...sk, _poly3d: clipped.map(p => ({ x: p.x, y: p.y, z: planeZAtPoint(triangle, p) })) }] : [];
    }),
  }));
}

function surfaceEntries(btm, settings) {
  const zones = new Map((btm.zones || []).map(z => [z.id, z]));
  const entries = [];
  for (const surf of btm.surfaces || []) {
    const zone = zones.get(surf.zoneId);
    if (!zone || !(zone.height > 0)) continue;
    if (surf.type === 'RoofCeiling') {
      for (const entry of roofEntries(surf)) entries.push({ ...entry, zone, type: 'RoofCeiling' });
    } else if (surf.type === 'Wall' || surf.type === 'Floor') {
      entries.push({ id: surf.id, sourceId: surf.id, polygon: surfacePolygon(surf), surface: surf, zone, type: surf.type, skylights: [] });
    }
  }
  return entries.filter(entry => {
    if (settings.scope === 'level') return entry.zone.levelIdx === settings.levelIdx;
    if (settings.scope === 'zone') return entry.zone.id === settings.zoneId;
    if (settings.scope === 'selected') return (settings.selectedSurfaceIds || []).includes(entry.sourceId);
    return true;
  });
}

function entryOpenings(entry, fallbackSolarT) {
  const openings = [];
  if (entry.type === 'Wall') {
    for (const win of entry.surface.windows || []) {
      if (win.subtype === 'door') continue;
      const isVoid = win.isVoid === true || win.subtype === 'hole';
      openings.push({ id: win.id, sourceId: win.id, polygon: wallOpeningPolygon(entry.surface, win), solarT: isVoid ? 1 : openingSolarT(win, fallbackSolarT), isVoid, zoneId: entry.zone.id });
    }
  }
  for (const sk of entry.skylights || []) {
    const polygon = sk._poly3d || (sk.pts || []).map(p => ({ x: p.x, y: p.y, z: entry.polygon[0]?.z || 0 }));
    if (polygon.length >= 3) openings.push({ id: sk.id, sourceId: sk.id, polygon, solarT: openingSolarT(sk, fallbackSolarT), zoneId: entry.zone.id });
  }
  return openings;
}

function entryOutwardNormal(entry) {
  // Wall endpoint order follows the zone ring emitted by the topology
  // compiler. Connected faces can be traced clockwise even though detached
  // block faces are usually counter-clockwise, so polygon winding alone is
  // not a reliable outward direction. The BTM surface normal is the canonical
  // zone-outward direction; use it to orient the polygon-derived normal while
  // retaining the real slope normal for pitched roof facets.
  return planeBasis(entry.polygon, entry.surface?.normal).n;
}

function makeCells(entries, settings, exteriorOnly = true) {
  const cells = [];
  const spacing = settings.gridSize || 1;
  const trueNorth = btmTrueNorth(settings);
  for (const entry of entries) {
    if (exteriorOnly && entry.surface.boundary !== 'Outdoors') continue;
    if (exteriorOnly && entry.type === 'Floor') continue;
    const openings = entryOpenings(entry, settings.solarTransmittance);
    const baseNormal = entryOutwardNormal(entry);
    const orientation = orientationFromNormal(baseNormal, trueNorth);
    const opaqueAssembly = entry.type === 'RoofCeiling' ? 'roof' : entry.type === 'Wall' ? 'wall' : 'floor';
    const opaqueCells = gridPolygon3D(entry.polygon, spacing, openings.map(o => o.polygon), baseNormal);
    opaqueCells.forEach((cell, index) => cells.push({
      ...cell,
      edgeClearanceM: polygonEdgeClearance(cell.centroid, [entry.polygon, ...openings.map(o => o.polygon)]),
      id: `${entry.id}:opaque:${index}`,
      sourceId: entry.sourceId,
      exportedId: entry.id,
      hostObstacleId: entry.id,
      kind: 'surface',
      assembly: opaqueAssembly,
      zoneId: entry.zone.id,
      levelIdx: entry.zone.levelIdx,
      ...orientation,
    }));
    if (!exteriorOnly) continue;
    for (const opening of openings) {
      if (opening.isVoid) continue;
      const openingCells = gridPolygon3D(opening.polygon, spacing, [], baseNormal);
      openingCells.forEach((cell, index) => cells.push({
        ...cell,
        id: `${entry.id}:opening:${opening.sourceId}:${index}`,
        sourceId: opening.sourceId,
        exportedId: opening.id,
        hostSourceId: entry.sourceId,
        hostObstacleId: entry.id,
        kind: 'window',
        assembly: 'window',
        solarTransmittance: opening.solarT,
        zoneId: entry.zone.id,
        levelIdx: entry.zone.levelIdx,
        ...orientation,
      }));
    }
  }
  return cells;
}

function btmTrueNorth(settings) { return Number.isFinite(+settings.trueNorth) ? +settings.trueNorth : 0; }

function receiverCells(entries, settings) {
  const all = [];
  const spacing = settings.interiorGridSize || settings.gridSize || 1;
  for (const entry of entries) {
    const mode = settings.interiorReceivers || 'floors';
    if (mode === 'floors' && entry.type !== 'Floor') continue;
    if (entry.type !== 'Floor' && entry.type !== 'Wall' && entry.type !== 'RoofCeiling') continue;
    const outward = entryOutwardNormal(entry);
    let receiverNormal;
    let assembly;
    if (entry.type === 'Floor') { receiverNormal = { x: 0, y: 0, z: 1 }; assembly = 'interior-floor'; }
    else if (entry.type === 'RoofCeiling') { receiverNormal = mul(outward, -1); assembly = 'interior-ceiling'; }
    else { receiverNormal = mul(outward, -1); assembly = 'interior-wall'; }
    const cells = gridPolygon3D(entry.polygon, spacing, entryOpenings(entry, settings.solarTransmittance).map(o => o.polygon), receiverNormal);
    cells.forEach((cell, index) => all.push({
      ...cell,
      normal: receiverNormal,
      id: `inside:${entry.zone.id}:${entry.id}:${index}`,
      sourceId: entry.sourceId,
      exportedId: entry.id,
      hostObstacleId: entry.id,
      kind: 'interior',
      assembly,
      zoneId: entry.zone.id,
      levelIdx: entry.zone.levelIdx,
      orientation: assembly === 'interior-floor' ? 'Horizontal' : orientationFromNormal(receiverNormal, btmTrueNorth(settings)).orientation,
    }));
  }
  return all;
}

function rayTriangle(origin, direction, tri) {
  const edge1 = sub(tri.b, tri.a), edge2 = sub(tri.c, tri.a);
  const p = cross(direction, edge2);
  const det = dot(edge1, p);
  if (Math.abs(det) < EPS) return null;
  const inv = 1 / det;
  const tvec = sub(origin, tri.a);
  const u = dot(tvec, p) * inv;
  if (u < -EPS || u > 1 + EPS) return null;
  const q = cross(tvec, edge1);
  const v = dot(direction, q) * inv;
  if (v < -EPS || u + v > 1 + EPS) return null;
  const t = dot(edge2, q) * inv;
  return t > 1e-4 ? t : null;
}

function triangulate3D(poly) {
  if (poly.length < 3) return [];
  const basis = planeBasis(poly);
  const projected = poly.map(p => projectPoint(p, basis));
  return triangulate2D(projected).map(tri => tri.map(p => liftPoint(p, basis)));
}

function buildObstacles(allEntries, shadingPolygons, fallbackSolarT) {
  const obstacles = [];
  for (const entry of allEntries) {
    const openings = entryOpenings(entry, fallbackSolarT);
    for (const [a, b, c] of triangulate3D(entry.polygon)) obstacles.push({
      a, b, c,
      id: entry.id,
      sourceId: entry.sourceId,
      kind: 'building',
      transmission: 0,
      openings,
    });
  }
  (shadingPolygons || []).forEach((shade, shadeIndex) => {
    const polygon = (shade.vertices || []).map(p => Array.isArray(p) ? { x: +p[0], y: +p[1], z: +p[2] } : { x: +p.x, y: +p.y, z: +p.z });
    if (polygon.length < 3) return;
    for (const [a, b, c] of triangulate3D(polygon)) obstacles.push({
      a, b, c,
      id: `shade:${shade.name || shadeIndex}`,
      sourceId: `shade:${shade.groupId || shade.name || shadeIndex}`,
      kind: 'shade',
      transmission: clamp(Number.isFinite(+shade.transmission) ? +shade.transmission : 0, 0, 1),
      openings: [],
    });
  });
  return obstacles;
}

function traceRay(origin, direction, obstacles, ignoredIds = new Set()) {
  const hits = [];
  for (const obstacle of obstacles) {
    if (ignoredIds.has(obstacle.id)) continue;
    const t = rayTriangle(origin, direction, obstacle);
    if (t == null || t < 0.008) continue;
    hits.push({ obstacle, t, point: add(origin, mul(direction, t)) });
  }
  hits.sort((a, b) => a.t - b.t);
  let transmission = 1;
  const seen = new Set();
  const openingIds = [];
  for (const hit of hits) {
    const obstacle = hit.obstacle;
    if (seen.has(obstacle.sourceId)) continue;
    if (obstacle.kind === 'building') {
      const opening = obstacle.openings.find(candidate => polygonPointInside3D(hit.point, candidate.polygon));
      if (opening) {
        const key = `opening:${opening.sourceId}`;
        if (!seen.has(key)) {
          transmission *= opening.solarT;
          openingIds.push(opening.sourceId);
          seen.add(key);
        }
        continue;
      }
      return { transmission: 0, openingIds, blockedBy: obstacle.sourceId };
    }
    transmission *= obstacle.transmission;
    seen.add(obstacle.sourceId);
    if (transmission <= EPS) return { transmission: 0, openingIds, blockedBy: obstacle.sourceId };
  }
  return { transmission, openingIds, blockedBy: null };
}

function pvEligible(cell, settings) {
  const allowed = settings.pvAssemblies || ['roof'];
  if (!allowed.includes(cell.assembly)) return false;
  if (settings.pvRequireSelected && !(settings.pvSelectedSurfaceIds || []).includes(cell.sourceId)) return false;
  if ((+settings.pvEdgeSetback || 0) > (cell.edgeClearanceM ?? Infinity)) return false;
  return true;
}

function processExteriorCells(cells, hours, obstacles, settings, progress) {
  const trueNorth = btmTrueNorth(settings);
  const albedo = clamp(+settings.groundReflectance || 0.2, 0, 1);
  const coverage = clamp((+settings.pvCoverage || 80) / 100, 0, 1);
  const efficiency = clamp((+settings.pvEfficiency || 20) / 100, 0, 1);
  const performanceRatio = clamp(1 - (+settings.pvLosses || 14) / 100, 0, 1);
  const minimumPvIrradiation = Math.max(0, +settings.pvMinIrradiation || 0);
  cells.forEach((cell, cellIndex) => {
    const monthly = Array(12).fill(0);
    const ignored = new Set([cell.hostObstacleId]);
    for (const hour of hours) {
      if (hour.sun.z <= 0 || (hour.dni <= 0 && hour.dhi <= 0 && hour.ghi <= 0)) continue;
      const sun = rotatePlanVector(hour.sun, trueNorth);
      const incidence = Math.max(0, dot(cell.normal, sun));
      const beamTransmission = incidence > 0 ? traceRay(add(cell.centroid, mul(cell.normal, 0.003)), sun, obstacles, ignored).transmission : 0;
      const cosTilt = clamp(cell.normal.z, -1, 1);
      const irradiance = hour.dni * incidence * beamTransmission
        + hour.dhi * Math.max(0, (1 + cosTilt) / 2)
        + hour.ghi * albedo * Math.max(0, (1 - cosTilt) / 2);
      monthly[hour.month - 1] += irradiance / 1000;
    }
    cell.monthlyIncidentKWhM2 = monthly;
    cell.incidentKWhM2 = monthly.reduce((a, b) => a + b, 0);
    if (cell.kind === 'window') {
      cell.monthlyTransmittedKWhM2 = monthly.map(v => v * cell.solarTransmittance);
      cell.transmittedKWhM2 = cell.monthlyTransmittedKWhM2.reduce((a, b) => a + b, 0);
    } else {
      cell.monthlyTransmittedKWhM2 = null;
      cell.transmittedKWhM2 = null;
    }
    cell.monthlyPvKWh = pvEligible(cell, settings) && cell.incidentKWhM2 >= minimumPvIrradiation
      ? monthly.map(v => v * cell.areaM2 * coverage * efficiency * performanceRatio) : null;
    cell.pvKWh = cell.monthlyPvKWh?.reduce((a, b) => a + b, 0) ?? null;
    if (cellIndex % 20 === 0) progress?.({ phase: 'exterior', fraction: cells.length ? cellIndex / cells.length : 1, completed: cellIndex, total: cells.length });
  });
  const usableAreaCap = Math.max(0, +settings.pvUsableAreaM2 || 0);
  if (usableAreaCap > 0) {
    let remaining = usableAreaCap;
    const ranked = cells.filter(cell => Number.isFinite(cell.pvKWh)).sort((a, b) => b.incidentKWhM2 - a.incidentKWhM2);
    for (const cell of ranked) {
      const panelArea = cell.areaM2 * coverage;
      const usedArea = Math.min(remaining, panelArea);
      if (usedArea <= EPS) { cell.monthlyPvKWh = null; cell.pvKWh = null; cell.pvUsableAreaM2 = 0; continue; }
      const scale = panelArea > EPS ? usedArea / panelArea : 0;
      cell.monthlyPvKWh = cell.monthlyPvKWh.map(value => value * scale);
      cell.pvKWh = cell.monthlyPvKWh.reduce((sum, value) => sum + value, 0);
      cell.pvUsableAreaM2 = usedArea;
      remaining -= usedArea;
      if (remaining <= EPS) remaining = 0;
    }
  }
}

function processInteriorCells(cells, hours, obstacles, settings, progress) {
  const trueNorth = btmTrueNorth(settings);
  const contributions = {};
  cells.forEach((cell, cellIndex) => {
    const monthly = Array(12).fill(0);
    const cellSources = {};
    const ignored = new Set([cell.hostObstacleId]);
    for (const hour of hours) {
      if (hour.sun.z <= 0 || hour.dni <= 0) continue;
      const sun = rotatePlanVector(hour.sun, trueNorth);
      const incidence = Math.max(0, dot(cell.normal, sun));
      if (incidence <= 0) continue;
      const trace = traceRay(add(cell.centroid, mul(cell.normal, 0.003)), sun, obstacles, ignored);
      if (trace.transmission <= 0 || !trace.openingIds.length) continue;
      const value = hour.dni * incidence * trace.transmission / 1000;
      monthly[hour.month - 1] += value;
      const sourceId = trace.openingIds.at(-1);
      if (!cellSources[sourceId]) cellSources[sourceId] = Array(12).fill(0);
      cellSources[sourceId][hour.month - 1] += value * cell.areaM2;
      if (!contributions[sourceId]) contributions[sourceId] = Array(12).fill(0);
      contributions[sourceId][hour.month - 1] += value * cell.areaM2;
    }
    cell.monthlyInteriorKWhM2 = monthly;
    cell.interiorKWhM2 = monthly.reduce((a, b) => a + b, 0);
    const absorptance = clamp(+(settings.interiorAbsorptance?.[cell.assembly] ?? 0.65), 0, 1);
    cell.absorptance = absorptance;
    cell.monthlyAbsorbedKWhM2 = monthly.map(value => value * absorptance);
    cell.absorbedKWhM2 = cell.monthlyAbsorbedKWhM2.reduce((a, b) => a + b, 0);
    cell.sourceWindowContributions = cellSources;
    if (cellIndex % 20 === 0) progress?.({ phase: 'interior', fraction: cells.length ? cellIndex / cells.length : 1, completed: cellIndex, total: cells.length });
  });
  return Object.fromEntries(Object.entries(contributions).map(([sourceId, monthlyKWh]) => [sourceId, {
    sourceId,
    monthlyKWh,
    kWh: monthlyKWh.reduce((a, b) => a + b, 0),
  }]));
}

function aggregate(cells, keyFn, labelFn, intensityField, monthlyField, totalField = null) {
  const groups = new Map();
  for (const cell of cells) {
    const intensity = cell[intensityField];
    if (totalField && !Number.isFinite(cell[totalField])) continue;
    if (!Number.isFinite(intensity) && !Number.isFinite(cell[totalField])) continue;
    const key = keyFn(cell);
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(cell), areaM2: 0, kWh: 0, monthlyKWh: Array(12).fill(0) });
    const group = groups.get(key);
    group.areaM2 += cell.areaM2;
    if (totalField && Number.isFinite(cell[totalField])) {
      group.kWh += cell[totalField];
      (cell.monthlyPvKWh || []).forEach((v, i) => { group.monthlyKWh[i] += v; });
    } else {
      group.kWh += intensity * cell.areaM2;
      (cell[monthlyField] || []).forEach((v, i) => { group.monthlyKWh[i] += v * cell.areaM2; });
    }
  }
  return [...groups.values()].map(group => ({
    ...group,
    kWhM2: group.areaM2 > 0 ? group.kWh / group.areaM2 : null,
    monthlyKWhM2: group.monthlyKWh.map(v => group.areaM2 > 0 ? v / group.areaM2 : null),
  }));
}

function range(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { min: null, max: null, robustMin: null, robustMax: null };
  const at = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
  return { min: sorted[0], max: sorted.at(-1), robustMin: at(0.02), robustMax: at(0.98) };
}

function buildGroups(exteriorCells, interiorCells) {
  const labels = { wall: 'Walls', window: 'Windows', roof: 'Roofs', 'interior-floor': 'Interior Floors', 'interior-wall': 'Interior Walls', 'interior-ceiling': 'Interior Ceilings' };
  const incidentArgs = ['incidentKWhM2', 'monthlyIncidentKWhM2'];
  const transmittedArgs = ['transmittedKWhM2', 'monthlyTransmittedKWhM2'];
  const interiorArgs = ['interiorKWhM2', 'monthlyInteriorKWhM2'];
  const absorbedArgs = ['absorbedKWhM2', 'monthlyAbsorbedKWhM2'];
  const make = (cells, valueArgs) => ({
    assembly: aggregate(cells, c => c.assembly, c => labels[c.assembly] || c.assembly, ...valueArgs),
    orientation: aggregate(cells, c => `${c.assembly}:${c.orientation}`, c => `${c.orientation} ${labels[c.assembly] || c.assembly}`, ...valueArgs),
    zone: aggregate(cells, c => c.zoneId, c => c.zoneId, ...valueArgs),
    level: aggregate(cells, c => String(c.levelIdx), c => `Level ${c.levelIdx + 1}`, ...valueArgs),
    surface: aggregate(cells, c => c.sourceId, c => c.sourceId, ...valueArgs),
  });
  return {
    incident: make(exteriorCells, incidentArgs),
    transmitted: make(exteriorCells.filter(c => c.kind === 'window'), transmittedArgs),
    interior: make(interiorCells, interiorArgs),
    absorbed: make(interiorCells, absorbedArgs),
    pv: {
      assembly: aggregate(exteriorCells, c => c.assembly, c => labels[c.assembly] || c.assembly, 'incidentKWhM2', 'monthlyIncidentKWhM2', 'pvKWh'),
      orientation: aggregate(exteriorCells, c => `${c.assembly}:${c.orientation}`, c => `${c.orientation} ${labels[c.assembly] || c.assembly}`, 'incidentKWhM2', 'monthlyIncidentKWhM2', 'pvKWh'),
      zone: aggregate(exteriorCells, c => c.zoneId, c => c.zoneId, 'incidentKWhM2', 'monthlyIncidentKWhM2', 'pvKWh'),
      level: aggregate(exteriorCells, c => String(c.levelIdx), c => `Level ${c.levelIdx + 1}`, 'incidentKWhM2', 'monthlyIncidentKWhM2', 'pvKWh'),
      surface: aggregate(exteriorCells, c => c.sourceId, c => c.sourceId, 'incidentKWhM2', 'monthlyIncidentKWhM2', 'pvKWh'),
    },
  };
}

export function robustRange(values) { return range(values); }

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function solarPaletteRgb(value, min, max) {
  if (!Number.isFinite(value)) return [96, 101, 112];
  // A collapsed range is common for zero-only direct-sun maps. Zero is the
  // low end of the solar scale, not an arbitrary mid-range red.
  const t = max > min ? clamp((value - min) / (max - min), 0, 1)
    : value > max ? 1 : 0;
  for (let i = 0; i < SOLAR_PALETTE.length - 1; i++) {
    const a = SOLAR_PALETTE[i], b = SOLAR_PALETTE[i + 1];
    if (t > b.t) continue;
    const f = (t - a.t) / (b.t - a.t || 1);
    const ca = hexToRgb(a.hex), cb = hexToRgb(b.hex);
    return ca.map((v, c) => Math.round(v + (cb[c] - v) * f));
  }
  return hexToRgb(SOLAR_PALETTE.at(-1).hex);
}

export function solarCellValue(cell, mode, monthIndex = null) {
  const monthlyField = mode === 'incident' ? 'monthlyIncidentKWhM2'
    : mode === 'transmitted' ? 'monthlyTransmittedKWhM2'
      : mode === 'interior' ? 'monthlyInteriorKWhM2'
        : mode === 'absorbed' ? 'monthlyAbsorbedKWhM2'
        : mode === 'pv' ? 'monthlyPvKWh' : null;
  const annualField = mode === 'incident' ? 'incidentKWhM2'
    : mode === 'transmitted' ? 'transmittedKWhM2'
      : mode === 'interior' ? 'interiorKWhM2'
        : mode === 'absorbed' ? 'absorbedKWhM2'
        : mode === 'pv' ? 'pvKWh' : null;
  if (Array.isArray(monthIndex) && monthlyField) {
    const values = cell[monthlyField];
    return Array.isArray(values) ? monthIndex.reduce((sum, index) => sum + (+values[index] || 0), 0) : null;
  }
  if (monthIndex != null && monthlyField) return cell[monthlyField]?.[monthIndex] ?? null;
  return annualField ? cell[annualField] ?? null : null;
}

// Spatial maps must compare like-for-like intensities. PV storage and summary
// values are totals per cell, so mapping those totals directly makes smaller
// clipped/triangulated cells look artificially weak and exposes mesh diagonals.
export function solarCellMapValue(cell, mode, monthIndex = null) {
  const value = solarCellValue(cell, mode, monthIndex);
  if (mode !== 'pv' || !Number.isFinite(value)) return value;
  return Number.isFinite(cell?.areaM2) && cell.areaM2 > EPS ? value / cell.areaM2 : null;
}

export function analyzeSolar({ btm, epw, location = null, shadingPolygons = [], settings = {}, progress = null }) {
  const started = performance.now();
  const normalized = {
    gridSize: 1,
    interiorGridSize: settings.gridSize || 1,
    solarTransmittance: 0.35,
    groundReflectance: 0.2,
    scope: 'whole',
    interiorReceivers: 'floors',
    interiorAbsorptance: { 'interior-floor': 0.7, 'interior-wall': 0.6, 'interior-ceiling': 0.5 },
    pvAssemblies: ['roof'],
    pvCoverage: 80,
    pvEfficiency: 20,
    pvLosses: 14,
    ...settings,
    trueNorth: settings.trueNorth ?? btm?.site?.trueNorth ?? 0,
  };
  const epwData = parseEpwSolarData(epw, location);
  const allEntries = surfaceEntries(btm, { ...normalized, scope: 'whole' });
  const scopedEntries = surfaceEntries(btm, normalized);
  progress?.({ phase: 'geometry', fraction: 0 });
  let exteriorCells = makeCells(scopedEntries, normalized, true);
  let interiorCells = normalized.includeInterior === false ? [] : receiverCells(scopedEntries, normalized);
  const warnings = [
    { type: 'solar-model', message: 'Exterior diffuse radiation uses an isotropic sky approximation; direct-beam shadows are geometrically traced.' },
    { type: 'interior-direct-only', message: 'Interior maps show direct solar landing and absorption only, not diffuse interreflection or thermal comfort.' },
    { type: 'pv-screening', message: 'PV potential is a screening estimate without temperature, inverter clipping, soiling, degradation, or electrical-layout losses.' },
  ];
  const maxCells = Math.max(100, +normalized.maxCells || 12000);
  if (exteriorCells.length + interiorCells.length > maxCells) {
    const factor = Math.sqrt((exteriorCells.length + interiorCells.length) / maxCells);
    normalized.gridSize *= factor;
    normalized.interiorGridSize *= factor;
    exteriorCells = makeCells(scopedEntries, normalized, true);
    interiorCells = normalized.includeInterior === false ? [] : receiverCells(scopedEntries, normalized);
    warnings.push({ type: 'grid-coarsened', requestedGridSize: settings.gridSize || 1, actualGridSize: normalized.gridSize, maxCells });
  }
  const obstacles = buildObstacles(allEntries, shadingPolygons, normalized.solarTransmittance);
  const daylightHours = epwData.hours.filter(hour => hour.sun.z > 0 && (hour.dni > 0 || hour.dhi > 0 || hour.ghi > 0));
  processExteriorCells(exteriorCells, daylightHours, obstacles, normalized, progress);
  const sourceWindowContributions = processInteriorCells(interiorCells, daylightHours, obstacles, normalized, progress);
  const groups = buildGroups(exteriorCells, interiorCells);
  const ranges = {
    incident: range(exteriorCells.map(c => c.incidentKWhM2)),
    transmitted: range(exteriorCells.map(c => c.transmittedKWhM2)),
    interior: range(interiorCells.map(c => c.interiorKWhM2)),
    absorbed: range(interiorCells.map(c => c.absorbedKWhM2)),
    pv: range(exteriorCells.map(c => c.pvKWh)),
  };
  const sum = (cells, field, multiplyArea = true) => cells.reduce((total, cell) => total + (Number.isFinite(cell[field]) ? cell[field] * (multiplyArea ? cell.areaM2 : 1) : 0), 0);
  const pvCoverageFactor = clamp((+normalized.pvCoverage || 80) / 100, 0, 1);
  const summaries = {
    incidentKWh: sum(exteriorCells, 'incidentKWhM2'),
    transmittedKWh: sum(exteriorCells, 'transmittedKWhM2'),
    interiorDirectKWh: sum(interiorCells, 'interiorKWhM2'),
    interiorAbsorbedKWh: sum(interiorCells, 'absorbedKWhM2'),
    pvKWh: sum(exteriorCells, 'pvKWh', false),
    pvPanelAreaM2: exteriorCells.reduce((total, cell) => total + (Number.isFinite(cell.pvKWh)
      ? (Number.isFinite(cell.pvUsableAreaM2) ? cell.pvUsableAreaM2 : cell.areaM2 * pvCoverageFactor) : 0), 0),
  };
  summaries.interiorCaptureRatio = summaries.transmittedKWh > EPS ? summaries.interiorDirectKWh / summaries.transmittedKWh : null;
  if (summaries.interiorDirectKWh > summaries.transmittedKWh * 1.02 + EPS) warnings.push({
    type: 'interior-energy-balance',
    message: 'Interior direct receiver energy exceeds glazing-transmitted energy; review receiver overlap and glazing geometry.',
  });
  progress?.({ phase: 'complete', fraction: 1 });
  return {
    schemaVersion: 'solar-result-1',
    meta: {
      climate: epwData.location,
      trueNorth: normalized.trueNorth,
      settings: normalized,
      daylightHourCount: daylightHours.length,
      exteriorCellCount: exteriorCells.length,
      interiorCellCount: interiorCells.length,
      seconds: (performance.now() - started) / 1000,
      generatedAt: new Date().toISOString(),
    },
    exteriorCells,
    interiorCells,
    groups,
    ranges,
    sourceWindowContributions,
    summaries,
    warnings,
  };
}
