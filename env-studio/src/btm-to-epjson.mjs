import {
  DEFAULT_ENERGY_PROPS,
  FILM_RESISTANCES,
  constructionToLayers,
  constructionToMaterial,
  mergeConstructionDefaults,
  mergeEnergyProps,
} from './energy-defaults.mjs';
import {
  assemblyToConstructionSpec,
  assemblyToWindowSpec,
} from './construction-library.mjs';
import {
  ENERGY_SCHEDULE_KEYS,
  energyScheduleCompactFields,
  normalizeEnergyScheduleSpec,
  normalizeEnergySchedules,
  resolveEnergySchedule,
} from './energy-schedules.mjs';
import {
  buildPitchedRoofGeometry,
  clipPolygonToTriangle2D,
  planeZAtPoint,
  roofClosureOpeningFits,
} from './pitched-roof-geometry.mjs?v=straight-skeleton-hip-20260731';

const DEG = Math.PI / 180;

const snap9 = v => {
  const x = Math.round(v * 1e9) / 1e9;
  return Object.is(x, -0) ? 0 : x;
};

function rotate2D(pt, angleDeg, cx, cy) {
  const a = -angleDeg * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  return { x: snap9(dx * cos - dy * sin + cx), y: snap9(dx * sin + dy * cos + cy) };
}

function shoelaceArea(footprint) {
  let s = 0;
  for (let i = 0; i < footprint.length; i++) {
    const p = footprint[i], q = footprint[(i + 1) % footprint.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

function buildingAnchor(zones) {
  let aSum = 0, xSum = 0, ySum = 0;
  for (const z of zones) {
    const a = Math.abs(shoelaceArea(z.footprint)) || 1e-9;
    aSum += a;
    xSum += a * z.centroid.x;
    ySum += a * z.centroid.y;
  }
  return { x: xSum / aSum, y: ySum / aSum };
}

function sanitize(id) {
  const s = String(id).replaceAll(':', '_').replaceAll(/[^A-Za-z0-9_]/g, '_');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sortedObject(obj) {
  if (Array.isArray(obj)) return obj.map(sortedObject);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortedObject(obj[k]);
  return out;
}

export function stringifyEpjson(epjson) {
  return JSON.stringify(sortedObject(epjson), null, 2) + '\n';
}

export function parseEpwLocation(epwText) {
  const text = epwText instanceof Uint8Array ? new TextDecoder().decode(epwText) : String(epwText);
  const line = text.split(/\r?\n/, 1)[0];
  const parts = line.split(',');
  if (parts[0] !== 'LOCATION' || parts.length < 10) {
    throw new Error('EPW LOCATION header is missing or malformed');
  }
  return {
    name: [parts[1], parts[3], parts[4]].filter(Boolean).join(' '),
    latitude: Number(parts[6]),
    longitude: Number(parts[7]),
    timeZone: Number(parts[8]),
    elevation: Number(parts[9]),
  };
}

function vertex(x, y, z) {
  return {
    vertex_x_coordinate: snap9(x),
    vertex_y_coordinate: snap9(y),
    vertex_z_coordinate: snap9(z),
  };
}

function orientPointsToNormal(points, desiredNormal) {
  if (points.length < 3 || !desiredNormal) return points;
  let nx = 0, ny = 0, nz = 0;
  for (let index = 0; index < points.length; index++) {
    const point = points[index], next = points[(index + 1) % points.length];
    nx += (point.y - next.y) * (point.z + next.z);
    ny += (point.z - next.z) * (point.x + next.x);
    nz += (point.x - next.x) * (point.y + next.y);
  }
  const dot = nx * (desiredNormal.x || 0) + ny * (desiredNormal.y || 0) + nz * (desiredNormal.z || 0);
  return dot >= 0 ? points : [...points].reverse();
}

function rotateNormal2D(normal, angleDeg) {
  const angle = -angleDeg * DEG;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return {
    x:(normal?.x || 0) * cos - (normal?.y || 0) * sin,
    y:(normal?.x || 0) * sin + (normal?.y || 0) * cos,
    z:normal?.z || 0,
  };
}

function surfaceVertices(surf, trueNorth, anchor) {
  if (surf.vertices3d?.length >= 3) {
    const desired = surf.normal || (surf.type === 'Floor' ? { x:0,y:0,z:-1 } : { x:0,y:0,z:1 });
    return orientPointsToNormal(surf.vertices3d.map(point => ({...point})), desired).map(p => {
      const xy = rotate2D(p, trueNorth, anchor.x, anchor.y);
      return vertex(xy.x, xy.y, p.z);
    });
  }
  if (surf.type === 'Wall') {
    const z0 = snap9(surf.zBase ?? 0);
    const z1 = snap9(z0 + surf.height);
    const points = orientPointsToNormal([
      {x:surf.p1.x,y:surf.p1.y,z:z1},
      {x:surf.p1.x,y:surf.p1.y,z:z0},
      {x:surf.p2.x,y:surf.p2.y,z:z0},
      {x:surf.p2.x,y:surf.p2.y,z:z1},
    ], surf.normal);
    return points.map(point => {
      const xy=rotate2D(point,trueNorth,anchor.x,anchor.y);
      return vertex(xy.x,xy.y,point.z);
    });
  }
  const z = snap9(surf.z ?? (surf.type === 'Floor' ? surf.zBase ?? 0 : (surf.zBase ?? 0) + surf.height));
  const desired = surf.normal || (surf.type === 'Floor' ? {x:0,y:0,z:-1} : {x:0,y:0,z:1});
  const ring = orientPointsToNormal(surf.footprint.map(point => ({x:point.x,y:point.y,z})), desired);
  return ring.map(point => {
    const xy=rotate2D(point,trueNorth,anchor.x,anchor.y);
    return vertex(xy.x,xy.y,z);
  });
}

function fenestrationVertices(surf, win, trueNorth, anchor) {
  const p1 = rotate2D(surf.p1, trueNorth, anchor.x, anchor.y);
  const p2 = rotate2D(surf.p2, trueNorth, anchor.x, anchor.y);
  let w1 = rotate2D({ x: win.x1, y: win.y1 }, trueNorth, anchor.x, anchor.y);
  let w2 = rotate2D({ x: win.x2, y: win.y2 }, trueNorth, anchor.x, anchor.y);
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const t1 = (w1.x - p1.x) * dx + (w1.y - p1.y) * dy;
  const t2 = (w2.x - p1.x) * dx + (w2.y - p1.y) * dy;
  if (t2 < t1) [w1, w2] = [w2, w1];
  const z0 = snap9((surf.zBase ?? 0) + win.z0);
  const z1 = snap9(z0 + win.height);
  const points=orientPointsToNormal([
    {x:w1.x,y:w1.y,z:z1},
    {x:w1.x,y:w1.y,z:z0},
    {x:w2.x,y:w2.y,z:z0},
    {x:w2.x,y:w2.y,z:z1},
  ],rotateNormal2D(surf.normal,trueNorth));
  return points.map(point=>vertex(point.x,point.y,point.z));
}

const ENERGYPLUS_VERTEX_TOLERANCE_M = 0.01;

// Mirror EnergyPlus' centimetre-scale coincident/collinear cleanup before the
// model reaches the simulator. Removing redundant points here eliminates
// warning noise; returning [] for a needle polygon lets the caller omit the
// sub-tolerance residue (and its reciprocal mate) instead of sending a surface
// that EnergyPlus will collapse to fewer than three sides.
function cleanEnergyVertices(vertices, tolerance = ENERGYPLUS_VERTEX_TOLERANCE_M) {
  const xyz=entry=>({
    x:+entry.vertex_x_coordinate,y:+entry.vertex_y_coordinate,z:+entry.vertex_z_coordinate,
  });
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
  const compact=[];
  for(const entry of vertices||[]){
    const point=xyz(entry);
    if(!compact.length||distance(point,xyz(compact.at(-1)))>1e-8)compact.push(entry);
  }
  if(compact.length>1&&distance(xyz(compact[0]),xyz(compact.at(-1)))<=1e-8)compact.pop();
  let changed=true;
  while(changed&&compact.length>=3){
    changed=false;
    for(let index=0;index<compact.length;index++){
      const a=xyz(compact[(index-1+compact.length)%compact.length]);
      const b=xyz(compact[index]);
      const c=xyz(compact[(index+1)%compact.length]);
      const ac={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};
      const ab={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
      const length=Math.hypot(ac.x,ac.y,ac.z);
      if(length<=1e-10){compact.splice(index,1);changed=true;break;}
      const cross={
        x:ab.y*ac.z-ab.z*ac.y,
        y:ab.z*ac.x-ab.x*ac.z,
        z:ab.x*ac.y-ab.y*ac.x,
      };
      const perpendicular=Math.hypot(cross.x,cross.y,cross.z)/length;
      const projection=(ab.x*ac.x+ab.y*ac.y+ab.z*ac.z)/(length*length);
      if(perpendicular<=tolerance&&projection>=-1e-8&&projection<=1+1e-8){
        compact.splice(index,1);changed=true;break;
      }
    }
  }
  return compact.length>=3&&areaOfVertices(compact)>1e-8?compact:[];
}

function compactSchedule(typeLimits, fields) {
  return { schedule_type_limits_name: typeLimits, data: fields.map(field => ({ field })) };
}

function alwaysSchedule(value, typeLimits = 'Fraction') {
  return compactSchedule(typeLimits, ['Through: 12/31', 'For: AllDays', 'Until: 24:00', value]);
}

function occupancySchedule() {
  return compactSchedule('Fraction', [
    'Through: 12/31',
    'For: AllDays',
    'Until: 08:00', 0,
    'Until: 18:00', 1,
    'Until: 24:00', 0,
  ]);
}

function makeNodeList(name, node) {
  return { [name]: { nodes: [{ node_name: node }] } };
}

function surfaceType(surf) {
  if (surf.type === 'Wall') return 'Wall';
  if (surf.type === 'Floor') return 'Floor';
  return surf.boundary === 'Surface' ? 'Ceiling' : 'Roof';
}

export function constructionKeyForSurface(surf) {
  if (surf.type === 'Wall') return surf.boundary === 'Surface' ? 'interiorWall' : 'extWall';
  if (surf.type === 'Floor') {
    if (surf.boundary === 'Ground') return 'groundFloor';
    if (surf.boundary === 'Surface') return 'slab';
    return 'exposedFloor';
  }
  return surf.boundary === 'Surface' ? 'slab' : 'roof';
}

// Shared by the EnergyPlus exporter and the 3D construction visualiser. The
// precedence is intentionally explicit: model/zone assembly, then an opening
// assembly, then individually authored opening values.
export function resolveEffectiveWindowSpec(source = {}, inheritedSpec = {}, constructionLibrary = {}) {
  const explicitFlags = source.energyOverrides && typeof source.energyOverrides === 'object';
  const localOverrides = explicitFlags ? {
    uValue:source.energyOverrides.uValue === true,
    shgc:source.energyOverrides.shgc === true,
  } : {
    // Backward compatibility for projects saved before override flags:
    // values differing from the old authored defaults were local edits.
    uValue:Number.isFinite(source.uValue) && Math.abs(source.uValue - 2.0) > 1e-9,
    shgc:Number.isFinite(source.shgc) && Math.abs(source.shgc - 0.40) > 1e-9,
  };
  const localAssemblySpec = source.energyAssemblyId
    ? assemblyToWindowSpec(source.energyAssemblyId, constructionLibrary)
    : {};
  const effective = { ...source, ...inheritedSpec, ...localAssemblySpec };
  if (localOverrides.uValue && Number.isFinite(source.uValue)) effective.uValue = source.uValue;
  if (localOverrides.shgc && Number.isFinite(source.shgc)) effective.shgc = source.shgc;
  return effective;
}

function boundaryFields(surf) {
  if (surf.boundary === 'Ground') {
    return { outside_boundary_condition: 'Ground', sun_exposure: 'NoSun', wind_exposure: 'NoWind' };
  }
  if (surf.boundary === 'Surface') {
    return {
      outside_boundary_condition: 'Surface',
      outside_boundary_condition_object: sanitize(surf.adjacentSurfaceId),
      sun_exposure: 'NoSun',
      wind_exposure: 'NoWind',
    };
  }
  return { outside_boundary_condition: 'Outdoors', sun_exposure: 'SunExposed', wind_exposure: 'WindExposed' };
}

function glazingKey(win, glazingVT) {
  return [win.uValue ?? 2.0, win.shgc ?? 0.40, win.vt ?? glazingVT].map(v => snap9(v)).join('|');
}

const OPAQUE_CONSTRUCTION_DEFINITIONS = Object.freeze({
  extWall:      Object.freeze({ materialName:'Material_ExtWall',      constructionName:'Construction_ExtWall',      filmKey:'wall' }),
  roof:         Object.freeze({ materialName:'Material_Roof',         constructionName:'Construction_Roof',         filmKey:'roof' }),
  interiorWall: Object.freeze({ materialName:'Material_InteriorWall', constructionName:'Construction_InteriorWall', filmKey:'interior' }),
  slab:         Object.freeze({ materialName:'Material_Slab',         constructionName:'Construction_Slab',         filmKey:'interior' }),
  exposedFloor: Object.freeze({ materialName:'Material_ExposedFloor', constructionName:'Construction_ExposedFloor', filmKey:'exposedFloor' }),
  groundFloor:  Object.freeze({ materialName:'Material_GroundFloor',  constructionName:'Construction_GroundFloor',  filmKey:'groundFloor' }),
  door:         Object.freeze({ materialName:'Material_Door',         constructionName:'Construction_Door',         filmKey:'wall' }),
});

function addOpaqueConstruction(epjson, key, spec, definition) {
  const layers = constructionToLayers(key, spec);
  if (!layers) {
    const { noMass, material } = constructionToMaterial(key, spec, FILM_RESISTANCES[definition.filmKey]);
    epjson[noMass ? 'Material:NoMass' : 'Material'][definition.materialName] = material;
    epjson.Construction[definition.constructionName] = { outside_layer: definition.materialName };
    return definition.constructionName;
  }

  const materialNames = layers.map((layer, index) => {
    const layerLabel = String(layer.name).replaceAll(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || `Layer_${index + 1}`;
    const materialName = `${definition.materialName}_L${index + 1}_${layerLabel}`;
    const objectType = layer.type === 'airGap'
      ? 'Material:AirGap'
      : layer.type === 'noMass' ? 'Material:NoMass' : 'Material';
    epjson[objectType][materialName] = layer.material;
    return materialName;
  });
  epjson.Construction[definition.constructionName] = {
    outside_layer: materialNames[0],
    ...Object.fromEntries(materialNames.slice(1).map((name, index) => [`layer_${index + 2}`, name])),
  };
  return definition.constructionName;
}

function areaOfVertices(vertices) {
  if (vertices.length < 3) return 0;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    nx += (a.vertex_y_coordinate - b.vertex_y_coordinate) * (a.vertex_z_coordinate + b.vertex_z_coordinate);
    ny += (a.vertex_z_coordinate - b.vertex_z_coordinate) * (a.vertex_x_coordinate + b.vertex_x_coordinate);
    nz += (a.vertex_x_coordinate - b.vertex_x_coordinate) * (a.vertex_y_coordinate + b.vertex_y_coordinate);
  }
  return 0.5 * Math.hypot(nx, ny, nz);
}

function surfaceDirection(vertices) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    nx += (a.vertex_y_coordinate - b.vertex_y_coordinate) * (a.vertex_z_coordinate + b.vertex_z_coordinate);
    ny += (a.vertex_z_coordinate - b.vertex_z_coordinate) * (a.vertex_x_coordinate + b.vertex_x_coordinate);
    nz += (a.vertex_x_coordinate - b.vertex_x_coordinate) * (a.vertex_y_coordinate + b.vertex_y_coordinate);
  }
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-9) return { azimuthDeg: null, tiltDeg: null, orientation: 'Unknown' };
  const tiltDeg = Math.acos(Math.max(-1, Math.min(1, nz / length))) / DEG;
  if (tiltDeg <= 10) return { azimuthDeg: null, tiltDeg: snap9(tiltDeg), orientation: 'Horizontal' };
  const azimuthDeg = ((Math.atan2(nx, ny) / DEG) % 360 + 360) % 360;
  const orientation = azimuthDeg >= 315 || azimuthDeg < 45 ? 'N'
    : azimuthDeg < 135 ? 'E'
      : azimuthDeg < 225 ? 'S' : 'W';
  return { azimuthDeg: snap9(azimuthDeg), tiltDeg: snap9(tiltDeg), orientation };
}

function addDefault(defaulted, target, field, value) {
  defaulted.push({ ...target, field, value });
}

function skylightRectangle(sk, warnings, warningType = 'skylight-approximated') {
  const pts = sk.pts || [];
  if (pts.length === 4 && !sk.type?.includes?.('circle')) return pts;
  const area = Math.abs(shoelaceArea(pts));
  const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
  const side = Math.sqrt(area || 1);
  warnings.push({ type: warningType, skylightId: sk.id });
  return [
    { x: c.x - side / 2, y: c.y - side / 2 },
    { x: c.x + side / 2, y: c.y - side / 2 },
    { x: c.x + side / 2, y: c.y + side / 2 },
    { x: c.x - side / 2, y: c.y + side / 2 },
  ];
}

const HORIZONTAL_EPS = 1e-8;
const DEFAULT_AIR_BOUNDARY_ACH = 0.5;
const DEFAULT_OUTDOOR_OPENING_FRACTION = 1;
const DEFAULT_OUTDOOR_DISCHARGE_COEFFICIENT = 0.65;
const DEFAULT_OUTDOOR_WIND_EFFECTIVENESS = 0.5;
const OPEN_ROOF_APERTURE_MATERIAL = 'WindowMaterial_OpenRoofAperture';
const OPEN_ROOF_APERTURE_CONSTRUCTION = 'Construction_OpenRoofAperture';
const OPEN_WALL_APERTURE_MATERIAL = 'WindowMaterial_OpenWallAperture';
const OPEN_WALL_APERTURE_CONSTRUCTION = 'Construction_OpenWallAperture';

function cleanHorizontalPolygon(points, eps = HORIZONTAL_EPS) {
  const compact = [];
  for (const point of points || []) {
    if (!compact.length || Math.hypot(point.x - compact.at(-1).x, point.y - compact.at(-1).y) > eps) {
      compact.push({ x:snap9(+point.x), y:snap9(+point.y) });
    }
  }
  if (compact.length > 1 && Math.hypot(compact[0].x - compact.at(-1).x, compact[0].y - compact.at(-1).y) <= eps) compact.pop();
  let changed = true;
  while (changed && compact.length > 3) {
    changed = false;
    for (let index = 0; index < compact.length; index++) {
      const previous = compact[(index - 1 + compact.length) % compact.length];
      const point = compact[index];
      const next = compact[(index + 1) % compact.length];
      const turn = (point.x - previous.x) * (next.y - point.y) -
        (point.y - previous.y) * (next.x - point.x);
      if (Math.abs(turn) <= eps) {
        compact.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return compact.length >= 3 && Math.abs(shoelaceArea(compact)) > eps ? compact : [];
}

function triangulateHorizontalPolygon(points) {
  const polygon = cleanHorizontalPolygon(points);
  if (polygon.length < 3) return [];
  const remaining = polygon.map((_, index) => index);
  const triangles = [];
  const ccw = shoelaceArea(polygon) > 0;
  const cross = (a, b, c) => (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);
  const inside = (point, a, b, c) => {
    const d1=cross(a,b,point), d2=cross(b,c,point), d3=cross(c,a,point);
    return !((d1 < -HORIZONTAL_EPS || d2 < -HORIZONTAL_EPS || d3 < -HORIZONTAL_EPS) &&
      (d1 > HORIZONTAL_EPS || d2 > HORIZONTAL_EPS || d3 > HORIZONTAL_EPS));
  };
  let guard = 0;
  while (remaining.length > 3 && guard++ < polygon.length * polygon.length) {
    let found = false;
    for (let index = 0; index < remaining.length; index++) {
      const ia=remaining[(index-1+remaining.length)%remaining.length];
      const ib=remaining[index];
      const ic=remaining[(index+1)%remaining.length];
      const turn = cross(polygon[ia], polygon[ib], polygon[ic]);
      if (ccw ? turn <= HORIZONTAL_EPS : turn >= -HORIZONTAL_EPS) continue;
      if (remaining.some(candidate => candidate !== ia && candidate !== ib && candidate !== ic &&
          inside(polygon[candidate], polygon[ia], polygon[ib], polygon[ic]))) continue;
      triangles.push([polygon[ia], polygon[ib], polygon[ic]].map(point => ({...point})));
      remaining.splice(index, 1);
      found = true;
      break;
    }
    if (!found) break;
  }
  if (remaining.length === 3) triangles.push(remaining.map(index => ({...polygon[index]})));
  return triangles;
}

function horizontalPolygonIsConvex(points) {
  const polygon = cleanHorizontalPolygon(points);
  if (polygon.length < 4) return true;
  let sign = 0;
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length], c = polygon[(index + 2) % polygon.length];
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(turn) <= HORIZONTAL_EPS) continue;
    const current = Math.sign(turn);
    if (sign && current !== sign) return false;
    sign = current;
  }
  return true;
}

// EnergyPlus' deterministic shadowing path rejects concave casting surfaces.
// Split arbitrary horizontal floor/roof polygons into convex triangles while
// preserving reciprocal Surface adjacency. This is an export-only operation:
// the editor and BTM retain their natural clean room polygon.
function expandNonConvexHorizontalSurfaces(sourceSurfaces, warnings) {
  const byId = new Map(sourceSurfaces.map(surface => [surface.id, surface]));
  const replacements = new Map();
  const processed = new Set();
  const fragmentsFor = (surface, parts, adjacentIds = []) => parts.map((footprint, index) => ({
    ...surface,
    id:`${surface.id}:convex:${String(index + 1).padStart(3, '0')}`,
    footprint:footprint.map(point => ({...point})),
    area:Math.abs(shoelaceArea(footprint)),
    adjacentSurfaceId:adjacentIds[index] || null,
    skylights:[],
    _convexFragmentOf:surface.id,
  }));
  for (const surface of sourceSurfaces) {
    if (processed.has(surface) || !['Floor','RoofCeiling'].includes(surface.type)
        || !surface.footprint?.length || horizontalPolygonIsConvex(surface.footprint)) continue;
    const openings = (surface.skylights || []).filter(opening => !opening.isVoid);
    if (openings.length) {
      warnings.push({type:'non-convex-horizontal-surface-with-opening-not-split', surfaceId:surface.id});
      continue;
    }
    const parts = triangulateHorizontalPolygon(surface.footprint);
    if (parts.length < 2) continue;
    const adjacent = surface.boundary === 'Surface' ? byId.get(surface.adjacentSurfaceId) : null;
    if (adjacent && ['Floor','RoofCeiling'].includes(adjacent.type)) {
      const primaryIds = parts.map((_, index) => `${surface.id}:convex:${String(index + 1).padStart(3, '0')}`);
      const adjacentIds = parts.map((_, index) => `${adjacent.id}:convex:${String(index + 1).padStart(3, '0')}`);
      replacements.set(surface, fragmentsFor(surface, parts, adjacentIds));
      replacements.set(adjacent, fragmentsFor(adjacent, parts.map(part => [...part].reverse()), primaryIds));
      processed.add(adjacent);
    } else {
      replacements.set(surface, fragmentsFor(surface, parts));
    }
    processed.add(surface);
    warnings.push({type:'non-convex-horizontal-surface-triangulated', surfaceId:surface.id, fragments:parts.length});
  }
  return sourceSurfaces.flatMap(surface => replacements.get(surface) || [surface]);
}

function clipHorizontalHalfPlane(subject, a, b, keepInside) {
  if (!subject?.length) return [];
  const side = point => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  const accepts = value => keepInside ? value >= -HORIZONTAL_EPS : value <= HORIZONTAL_EPS;
  const output = [];
  let start = subject.at(-1);
  let startSide = side(start);
  let startAccepted = accepts(startSide);
  for (const end of subject) {
    const endSide = side(end);
    const endAccepted = accepts(endSide);
    if (startAccepted !== endAccepted) {
      const denominator = startSide - endSide;
      const t = Math.abs(denominator) > HORIZONTAL_EPS
        ? Math.max(0, Math.min(1, startSide / denominator)) : 0;
      output.push({ x:start.x + (end.x - start.x) * t, y:start.y + (end.y - start.y) * t });
    }
    if (endAccepted) output.push({...end});
    start = end;
    startSide = endSide;
    startAccepted = endAccepted;
  }
  return cleanHorizontalPolygon(output);
}

function intersectConvexHorizontalPolygons(subject, clip) {
  const orientedClip = shoelaceArea(clip) >= 0 ? clip : [...clip].reverse();
  let output = cleanHorizontalPolygon(subject);
  for (let index = 0; index < orientedClip.length && output.length; index++) {
    output = clipHorizontalHalfPlane(
      output, orientedClip[index], orientedClip[(index + 1) % orientedClip.length], true);
  }
  return output;
}

function subtractConvexHorizontalPolygon(subject, clip) {
  const orientedClip = shoelaceArea(clip) >= 0 ? clip : [...clip].reverse();
  let inside = cleanHorizontalPolygon(subject);
  const outside = [];
  for (let index = 0; index < orientedClip.length && inside.length; index++) {
    const a = orientedClip[index], b = orientedClip[(index + 1) % orientedClip.length];
    const piece = clipHorizontalHalfPlane(inside, a, b, false);
    if (piece.length) outside.push(piece);
    inside = clipHorizontalHalfPlane(inside, a, b, true);
  }
  return outside;
}

function subtractHorizontalOpenings(footprint, openings) {
  let fragments = triangulateHorizontalPolygon(footprint);
  const cutters = openings.flatMap(opening => triangulateHorizontalPolygon(opening.pts));
  for (const cutter of cutters) {
    fragments = fragments.flatMap(fragment => subtractConvexHorizontalPolygon(fragment, cutter));
    if (!fragments.length) break;
  }
  return fragments.map(fragment => cleanHorizontalPolygon(fragment)).filter(fragment => fragment.length);
}

function polygonIntersectionArea(a, b) {
  let area = 0;
  for (const ta of triangulateHorizontalPolygon(a)) {
    for (const tb of triangulateHorizontalPolygon(b)) {
      area += Math.abs(shoelaceArea(intersectConvexHorizontalPolygons(ta, tb)));
    }
  }
  return area;
}

function horizontalGeometryKey(points) {
  return cleanHorizontalPolygon(points).map(point => `${point.x.toFixed(8)},${point.y.toFixed(8)}`).sort().join('|');
}

function normalizedAirBoundaryConfig(opening, defaulted) {
  const airflowMode = opening.airflowMode === 'none' ? 'none' : 'simpleMixing';
  const simpleMixingACH = Number.isFinite(+opening.simpleMixingACH) && +opening.simpleMixingACH >= 0
    ? +opening.simpleMixingACH : DEFAULT_AIR_BOUNDARY_ACH;
  if (opening.airflowMode === undefined) {
    defaulted.push({ openingId:opening.id, field:'airflowMode', value:'simpleMixing' });
  }
  if (airflowMode === 'simpleMixing' && !Number.isFinite(+opening.simpleMixingACH)) {
    defaulted.push({ openingId:opening.id, field:'simpleMixingACH', value:DEFAULT_AIR_BOUNDARY_ACH });
  }
  return { airflowMode, simpleMixingACH:snap9(simpleMixingACH) };
}

function normalizedOutdoorOpeningConfig(opening, zone, defaulted) {
  const outdoorAirflowMode = opening.outdoorAirflowMode === 'none' ? 'none' : 'windAndStack';
  const outdoorOpeningFraction = Number.isFinite(+opening.outdoorOpeningFraction)
    ? Math.max(0, Math.min(1, +opening.outdoorOpeningFraction))
    : DEFAULT_OUTDOOR_OPENING_FRACTION;
  const outdoorDischargeCoefficient = Number.isFinite(+opening.outdoorDischargeCoefficient)
    ? Math.max(0.01, Math.min(1, +opening.outdoorDischargeCoefficient))
    : DEFAULT_OUTDOOR_DISCHARGE_COEFFICIENT;
  const outdoorWindEffectiveness = Number.isFinite(+opening.outdoorWindEffectiveness)
    ? Math.max(0, Math.min(1, +opening.outdoorWindEffectiveness))
    : DEFAULT_OUTDOOR_WIND_EFFECTIVENESS;
  const defaultStackHeight = Math.max(0.1, +(zone?.height || 3) / 2);
  const outdoorStackHeight = Number.isFinite(+opening.outdoorStackHeight) && +opening.outdoorStackHeight > 0
    ? +opening.outdoorStackHeight : defaultStackHeight;
  if (opening.outdoorAirflowMode === undefined) {
    defaulted.push({ openingId:opening.id, field:'outdoorAirflowMode', value:'windAndStack' });
  }
  if (!Number.isFinite(+opening.outdoorOpeningFraction)) {
    defaulted.push({ openingId:opening.id, field:'outdoorOpeningFraction', value:DEFAULT_OUTDOOR_OPENING_FRACTION });
  }
  if (!Number.isFinite(+opening.outdoorDischargeCoefficient)) {
    defaulted.push({ openingId:opening.id, field:'outdoorDischargeCoefficient', value:DEFAULT_OUTDOOR_DISCHARGE_COEFFICIENT });
  }
  if (!Number.isFinite(+opening.outdoorWindEffectiveness)) {
    defaulted.push({ openingId:opening.id, field:'outdoorWindEffectiveness', value:DEFAULT_OUTDOOR_WIND_EFFECTIVENESS });
  }
  if (!(Number.isFinite(+opening.outdoorStackHeight) && +opening.outdoorStackHeight > 0)) {
    defaulted.push({ openingId:opening.id, field:'outdoorStackHeight', value:snap9(defaultStackHeight) });
  }
  return {
    outdoorAirflowMode,
    outdoorOpeningFraction:snap9(outdoorOpeningFraction),
    outdoorDischargeCoefficient:snap9(outdoorDischargeCoefficient),
    outdoorWindEffectiveness:snap9(outdoorWindEffectiveness),
    outdoorStackHeight:snap9(outdoorStackHeight),
  };
}

function airBoundarySurfaceFragment(source, footprint, id, adjacentSurfaceId, config) {
  return {
    ...source,
    id,
    adjacentSurfaceId,
    footprint:footprint.map(point => ({...point})),
    area:Math.abs(shoelaceArea(footprint)),
    skylights:[],
    _airBoundary:{ ...config },
    sourceHorizontalSurfaceId:source.sourceHorizontalSurfaceId || source.id,
  };
}

function opaqueHorizontalSurfaceFragment(source, footprint, id, adjacentSurfaceId) {
  return {
    ...source,
    id,
    adjacentSurfaceId,
    footprint:footprint.map(point => ({...point})),
    area:Math.abs(shoelaceArea(footprint)),
    skylights:(source.skylights || []).filter(opening => !opening.isVoid),
    sourceHorizontalSurfaceId:source.sourceHorizontalSurfaceId || source.id,
  };
}

function isWallVoid(opening) {
  return opening?.isVoid === true || opening?.subtype === 'hole';
}

function wallOpeningLocalRect(reference, host, opening) {
  const dx = reference.p2.x - reference.p1.x;
  const dy = reference.p2.y - reference.p1.y;
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) return null;
  const ux = dx / length, uy = dy / length;
  const project = point => (point.x - reference.p1.x) * ux + (point.y - reference.p1.y) * uy;
  const first = project({ x:opening.x1, y:opening.y1 });
  const second = project({ x:opening.x2, y:opening.y2 });
  const t0 = Math.max(0, Math.min(length, Math.min(first, second)));
  const t1 = Math.max(0, Math.min(length, Math.max(first, second)));
  const hostBottom = +(host.zBase ?? 0);
  const referenceBottom = +(reference.zBase ?? 0);
  const referenceTop = referenceBottom + +(reference.height ?? 0);
  const z0 = Math.max(referenceBottom, Math.min(referenceTop, hostBottom + +(opening.z0 ?? 0)));
  const z1 = Math.max(referenceBottom, Math.min(referenceTop, hostBottom + +(opening.z0 ?? 0) + +(opening.height ?? 0)));
  return t1 - t0 > 1e-8 && z1 - z0 > 1e-8 ? { t0, t1, z0, z1 } : null;
}

function wallRectKey(rect) {
  return [rect.t0, rect.t1, rect.z0, rect.z1].map(value => snap9(value).toFixed(8)).join('|');
}

function wallRectIntersection(a, b) {
  const rect = {
    t0:Math.max(a.t0, b.t0), t1:Math.min(a.t1, b.t1),
    z0:Math.max(a.z0, b.z0), z1:Math.min(a.z1, b.z1),
  };
  return rect.t1 - rect.t0 > 1e-8 && rect.z1 - rect.z0 > 1e-8 ? rect : null;
}

function wallRectArea(rect) {
  return Math.max(0, rect.t1 - rect.t0) * Math.max(0, rect.z1 - rect.z0);
}

function wallPointAt(reference, t) {
  const dx = reference.p2.x - reference.p1.x;
  const dy = reference.p2.y - reference.p1.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x:reference.p1.x + dx * t / length, y:reference.p1.y + dy * t / length };
}

function verticalWallSurfaceFragment(source, reference, rect, id, adjacentSurfaceId, config = null) {
  const p1 = wallPointAt(reference, rect.t0);
  const p2 = wallPointAt(reference, rect.t1);
  return {
    ...source,
    id,
    adjacentSurfaceId,
    p1, p2,
    zBase:rect.z0,
    height:rect.z1 - rect.z0,
    area:wallRectArea(rect),
    vertices3d:[
      { ...p1, z:rect.z1 }, { ...p1, z:rect.z0 },
      { ...p2, z:rect.z0 }, { ...p2, z:rect.z1 },
    ],
    windows:[],
    ...(config ? { _airBoundary:{ ...config } } : {}),
    sourceVerticalSurfaceId:source.sourceVerticalSurfaceId || source.id,
  };
}

function clippedWallOpening(source, reference, fragment, intersection, id, adjacentOpeningId) {
  const p1 = wallPointAt(reference, intersection.t0);
  const p2 = wallPointAt(reference, intersection.t1);
  return {
    ...source,
    id,
    x1:p1.x, y1:p1.y, x2:p2.x, y2:p2.y,
    z0:intersection.z0 - fragment.zBase,
    height:intersection.z1 - intersection.z0,
    width:intersection.t1 - intersection.t0,
    _sourceOpeningId:source._sourceOpeningId || source.id,
    _adjacentOpeningId:adjacentOpeningId,
  };
}

function expandInterzoneWallPair(surface, adjacent, warnings, defaulted) {
  const candidates = [
    ...(surface.windows || []).map(opening => ({ host:surface, opening })),
    ...(adjacent.windows || []).map(opening => ({ host:adjacent, opening })),
  ];
  const voidsByGeometry = new Map();
  for (const candidate of candidates) {
    if (!isWallVoid(candidate.opening)) continue;
    const rect = wallOpeningLocalRect(surface, candidate.host, candidate.opening);
    if (rect && !voidsByGeometry.has(wallRectKey(rect))) voidsByGeometry.set(wallRectKey(rect), { ...candidate, rect });
  }
  const voids = [...voidsByGeometry.values()].sort((a, b) => wallRectKey(a.rect).localeCompare(wallRectKey(b.rect)));
  if (!voids.length) return null;

  for (let a = 0; a < voids.length; a++) {
    for (let b = a + 1; b < voids.length; b++) {
      if (wallRectIntersection(voids[a].rect, voids[b].rect)) {
        warnings.push({
          type:'overlapping-air-boundary-openings-not-modeled',
          surfaceId:surface.id,
          adjacentSurfaceId:adjacent.id,
        });
        return null;
      }
    }
  }

  const length = Math.hypot(surface.p2.x - surface.p1.x, surface.p2.y - surface.p1.y);
  const bottom = +(surface.zBase ?? 0);
  const top = bottom + +(surface.height ?? 0);
  const tBreaks = [...new Set([0, length, ...voids.flatMap(item => [item.rect.t0, item.rect.t1])].map(snap9))].sort((a, b) => a - b);
  const zBreaks = [...new Set([bottom, top, ...voids.flatMap(item => [item.rect.z0, item.rect.z1])].map(snap9))].sort((a, b) => a - b);
  const opaqueRects = [];
  for (let ti = 0; ti < tBreaks.length - 1; ti++) {
    for (let zi = 0; zi < zBreaks.length - 1; zi++) {
      const rect = { t0:tBreaks[ti], t1:tBreaks[ti + 1], z0:zBreaks[zi], z1:zBreaks[zi + 1] };
      if (wallRectArea(rect) <= 1e-8) continue;
      const midpoint = { t:(rect.t0 + rect.t1) / 2, z:(rect.z0 + rect.z1) / 2 };
      if (voids.some(item => midpoint.t > item.rect.t0 + 1e-9 && midpoint.t < item.rect.t1 - 1e-9 &&
        midpoint.z > item.rect.z0 + 1e-9 && midpoint.z < item.rect.z1 - 1e-9)) continue;
      opaqueRects.push(rect);
    }
  }
  const expectedArea = length * Math.max(0, top - bottom) - voids.reduce((sum, item) => sum + wallRectArea(item.rect), 0);
  const exportedOpaqueArea = opaqueRects.reduce((sum, rect) => sum + wallRectArea(rect), 0);
  if (Math.abs(exportedOpaqueArea - expectedArea) > Math.max(1e-6, Math.abs(expectedArea) * 1e-7)) {
    warnings.push({
      type:'air-boundary-split-failed', surfaceId:surface.id,
      expectedOpaqueArea:snap9(expectedArea), exportedOpaqueArea:snap9(exportedOpaqueArea),
    });
    return null;
  }

  const surfaceReplacements = [];
  const adjacentReplacements = [];
  const pairedOpaqueFragments = [];
  opaqueRects.forEach((rect, index) => {
    const suffix = String(index + 1).padStart(3, '0');
    const surfaceId = `${surface.id}:opaque:${suffix}`;
    const adjacentId = `${adjacent.id}:opaque:${suffix}`;
    const first = verticalWallSurfaceFragment(surface, surface, rect, surfaceId, adjacentId);
    const second = verticalWallSurfaceFragment(adjacent, surface, rect, adjacentId, surfaceId);
    surfaceReplacements.push(first);
    adjacentReplacements.push(second);
    pairedOpaqueFragments.push({ rect, first, second, suffix });
  });

  // Preserve windows and doors that share the interzone wall. If an opening
  // crosses a fragment seam introduced by a hole, emit paired clipped pieces
  // with explicit reciprocal links rather than silently dropping it.
  const solidOpeningsByGeometry = new Map();
  for (const candidate of candidates) {
    if (isWallVoid(candidate.opening)) continue;
    const rect = wallOpeningLocalRect(surface, candidate.host, candidate.opening);
    if (rect && !solidOpeningsByGeometry.has(wallRectKey(rect))) solidOpeningsByGeometry.set(wallRectKey(rect), { ...candidate, rect });
  }
  const solidOpenings = [...solidOpeningsByGeometry.values()].sort((a, b) => wallRectKey(a.rect).localeCompare(wallRectKey(b.rect)));
  pairedOpaqueFragments.forEach(({ rect, first, second, suffix }, fragmentIndex) => {
    solidOpenings.forEach((item, openingIndex) => {
      const intersection = wallRectIntersection(rect, item.rect);
      if (!intersection) return;
      const token = `${String(openingIndex + 1).padStart(3, '0')}_${String(fragmentIndex + 1).padStart(3, '0')}`;
      const firstId = `${first.id}:opening:${token}`;
      const secondId = `${second.id}:opening:${token}`;
      first.windows.push(clippedWallOpening(item.opening, surface, first, intersection, firstId, secondId));
      second.windows.push(clippedWallOpening(item.opening, surface, second, intersection, secondId, firstId));
    });
  });

  voids.forEach((item, index) => {
    const suffix = String(index + 1).padStart(3, '0');
    const openingToken = sanitize(item.opening._openingId || item.opening.id || `opening_${suffix}`);
    const surfaceId = `${surface.id}:air:${openingToken}:${suffix}`;
    const adjacentId = `${adjacent.id}:air:${openingToken}:${suffix}`;
    const config = {
      ...normalizedAirBoundaryConfig(item.opening, defaulted),
      sourceOpeningId:item.opening._openingId || item.opening.id || null,
      openingGroupId:item.opening.openingGroupId || null,
    };
    surfaceReplacements.push(verticalWallSurfaceFragment(surface, surface, item.rect, surfaceId, adjacentId, config));
    adjacentReplacements.push(verticalWallSurfaceFragment(adjacent, surface, item.rect, adjacentId, surfaceId, config));
    warnings.push(config.airflowMode === 'simpleMixing' ? {
      type:'air-boundary-simple-mixing-assumption',
      openingId:config.sourceOpeningId,
      airChangesPerHour:config.simpleMixingACH,
    } : {
      type:'air-boundary-radiation-only',
      openingId:config.sourceOpeningId,
    });
  });
  return { surfaceReplacements, adjacentReplacements };
}

// EnergyPlus base surfaces cannot contain holes. Replace every interzone slab
// or wall pair carrying voids with reciprocal opaque fragments around the void
// plus a reciprocal Construction:AirBoundary surface pair over each opening.
function expandInterzoneAirBoundaries(sourceSurfaces, warnings, defaulted) {
  const byId = new Map(sourceSurfaces.map(surface => [surface.id, surface]));
  const replacements = new Map();
  const processed = new Set();
  for (const surface of sourceSurfaces) {
    if (surface.boundary !== 'Surface' || !surface.adjacentSurfaceId) continue;
    const adjacent = byId.get(surface.adjacentSurfaceId);
    if (!adjacent || adjacent.boundary !== 'Surface') continue;
    const pairKey = [surface.id, adjacent.id].sort().join('|');
    if (processed.has(pairKey)) continue;
    processed.add(pairKey);

    if (surface.type === 'Wall' && adjacent.type === 'Wall') {
      const primary = sanitize(surface.id).localeCompare(sanitize(adjacent.id)) <= 0 ? surface : adjacent;
      const secondary = primary === surface ? adjacent : surface;
      const wallPair = expandInterzoneWallPair(primary, secondary, warnings, defaulted);
      if (wallPair) {
        replacements.set(primary, wallPair.surfaceReplacements);
        replacements.set(secondary, wallPair.adjacentReplacements);
      }
      continue;
    }
    if (![surface.type, adjacent.type].includes('Floor') ||
        ![surface.type, adjacent.type].includes('RoofCeiling')) continue;

    const candidates = [...(surface.skylights || []), ...(adjacent.skylights || [])]
      .filter(opening => opening.isVoid && cleanHorizontalPolygon(opening.pts).length >= 3);
    const uniqueByGeometry = new Map();
    for (const opening of candidates) {
      const geometryKey = horizontalGeometryKey(opening.pts);
      if (!uniqueByGeometry.has(geometryKey)) uniqueByGeometry.set(geometryKey, opening);
    }
    const openings = [...uniqueByGeometry.values()].sort((a, b) =>
      String(a.openingGroupId || a.id).localeCompare(String(b.openingGroupId || b.id)));
    if (!openings.length) continue;

    let overlapping = false;
    for (let a = 0; a < openings.length && !overlapping; a++) {
      for (let b = a + 1; b < openings.length; b++) {
        if (polygonIntersectionArea(openings[a].pts, openings[b].pts) > HORIZONTAL_EPS) {
          overlapping = true;
          break;
        }
      }
    }
    if (overlapping) {
      warnings.push({
        type:'overlapping-air-boundary-openings-not-modeled',
        surfaceId:surface.id,
        adjacentSurfaceId:adjacent.id,
      });
      continue;
    }

    const opaqueFragments = subtractHorizontalOpenings(surface.footprint, openings);
    const expectedArea = Math.abs(shoelaceArea(surface.footprint)) -
      openings.reduce((sum, opening) => sum + Math.abs(shoelaceArea(opening.pts)), 0);
    const exportedOpaqueArea = opaqueFragments.reduce((sum, fragment) => sum + Math.abs(shoelaceArea(fragment)), 0);
    if (Math.abs(exportedOpaqueArea - expectedArea) > Math.max(1e-6, Math.abs(expectedArea) * 1e-7)) {
      warnings.push({
        type:'air-boundary-split-failed', surfaceId:surface.id,
        expectedOpaqueArea:snap9(expectedArea), exportedOpaqueArea:snap9(exportedOpaqueArea),
      });
      continue;
    }

    const surfaceReplacements = [];
    const adjacentReplacements = [];
    opaqueFragments.forEach((footprint, index) => {
      const suffix = String(index + 1).padStart(3, '0');
      const surfaceId = `${surface.id}:opaque:${suffix}`;
      const adjacentId = `${adjacent.id}:opaque:${suffix}`;
      surfaceReplacements.push(opaqueHorizontalSurfaceFragment(surface, footprint, surfaceId, adjacentId));
      adjacentReplacements.push(opaqueHorizontalSurfaceFragment(adjacent, footprint, adjacentId, surfaceId));
    });
    openings.forEach((opening, index) => {
      const suffix = String(index + 1).padStart(3, '0');
      const openingToken = sanitize(opening.openingGroupId || opening.id || `opening_${suffix}`);
      const surfaceId = `${surface.id}:air:${openingToken}:${suffix}`;
      const adjacentId = `${adjacent.id}:air:${openingToken}:${suffix}`;
      const footprint = cleanHorizontalPolygon(opening.pts);
      const config = {
        ...normalizedAirBoundaryConfig(opening, defaulted),
        sourceOpeningId:opening.id || null,
        openingGroupId:opening.openingGroupId || null,
      };
      surfaceReplacements.push(airBoundarySurfaceFragment(surface, footprint, surfaceId, adjacentId, config));
      adjacentReplacements.push(airBoundarySurfaceFragment(adjacent, footprint, adjacentId, surfaceId, config));
      warnings.push(config.airflowMode === 'simpleMixing' ? {
        type:'air-boundary-simple-mixing-assumption',
        openingId:config.sourceOpeningId,
        airChangesPerHour:config.simpleMixingACH,
      } : {
        type:'air-boundary-radiation-only',
        openingId:config.sourceOpeningId,
      });
    });
    replacements.set(surface, surfaceReplacements);
    replacements.set(adjacent, adjacentReplacements);
  }
  return sourceSurfaces.flatMap(surface => replacements.get(surface) || [surface]);
}

function triangleArea3D(triangle) {
  const [a,b,c]=triangle;
  const u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
  const v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};
  return Math.hypot(u.y*v.z-u.z*v.y,u.z*v.x-u.x*v.z,u.x*v.y-u.y*v.x)/2;
}

function mergeClippedCoplanarRoofTriangles(triangles) {
  const key=point=>`${point.x.toFixed(8)},${point.y.toFixed(8)},${point.z.toFixed(8)}`;
  const plane=triangle=>{
    const [a,b,c]=triangle;
    const u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
    const v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};
    let n={x:u.y*v.z-u.z*v.y,y:u.z*v.x-u.x*v.z,z:u.x*v.y-u.y*v.x};
    const length=Math.hypot(n.x,n.y,n.z)||1;
    n={x:n.x/length,y:n.y/length,z:n.z/length};
    if(n.z<0)n={x:-n.x,y:-n.y,z:-n.z};
    return {n,d:n.x*a.x+n.y*a.y+n.z*a.z};
  };
  const planes=triangles.map(plane);
  const parent=triangles.map((_,index)=>index);
  const find=index=>{while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;};
  const join=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[b]=a;};
  for(let i=0;i<triangles.length;i++)for(let j=i+1;j<triangles.length;j++){
    const keysA=new Set(triangles[i].map(key));
    const shared=triangles[j].map(key).filter(vertexKey=>keysA.has(vertexKey));
    const alignment=planes[i].n.x*planes[j].n.x+planes[i].n.y*planes[j].n.y+planes[i].n.z*planes[j].n.z;
    if(shared.length===2&&alignment>1-1e-8&&Math.abs(planes[i].d-planes[j].d)<1e-7)join(i,j);
  }
  const components=new Map();
  triangles.forEach((_,index)=>{
    const root=find(index);
    if(!components.has(root))components.set(root,[]);
    components.get(root).push(index);
  });
  const output=[];
  components.forEach(indices=>{
    if(indices.length===1){output.push(triangles[indices[0]].map(point=>({...point})));return;}
    const vertices=new Map();
    const boundary=new Map();
    indices.forEach(index=>triangles[index].forEach((a,vertexIndex)=>{
      const b=triangles[index][(vertexIndex+1)%3],aKey=key(a),bKey=key(b);
      vertices.set(aKey,a);vertices.set(bKey,b);
      const edgeKey=aKey<bKey?`${aKey}|${bKey}`:`${bKey}|${aKey}`;
      if(boundary.has(edgeKey))boundary.delete(edgeKey);
      else boundary.set(edgeKey,{aKey,bKey});
    }));
    const adjacency=new Map();
    boundary.forEach(edge=>{
      if(!adjacency.has(edge.aKey))adjacency.set(edge.aKey,[]);
      if(!adjacency.has(edge.bKey))adjacency.set(edge.bKey,[]);
      adjacency.get(edge.aKey).push(edge.bKey);adjacency.get(edge.bKey).push(edge.aKey);
    });
    if(!adjacency.size||[...adjacency.values()].some(neighbors=>neighbors.length!==2)){
      indices.forEach(index=>output.push(triangles[index].map(point=>({...point}))));
      return;
    }
    const start=[...adjacency.keys()].sort()[0];
    const loop=[];
    let previous=null,current=start,closed=false;
    while(current&&loop.length<=boundary.size){
      loop.push(vertices.get(current));
      const neighbors=adjacency.get(current);
      const next=neighbors[0]===previous?neighbors[1]:neighbors[0];
      previous=current;current=next;
      if(current===start){closed=true;break;}
    }
    if(!closed||loop.length<3){
      indices.forEach(index=>output.push(triangles[index].map(point=>({...point}))));
      return;
    }
    const componentPlane=planes[indices[0]];
    const parts=triangulateHorizontalPolygon(loop.map(point=>({x:point.x,y:point.y})));
    if(!parts.length){
      indices.forEach(index=>output.push(triangles[index].map(point=>({...point}))));
      return;
    }
    parts.forEach(part=>output.push(orientPointsToNormal(part.map(point=>({
      x:point.x,y:point.y,
      z:(componentPlane.d-componentPlane.n.x*point.x-componentPlane.n.y*point.y)/componentPlane.n.z,
    })),componentPlane.n)));
  });
  return output;
}

function polygonArea3D(points) {
  if(points.length<3)return 0;
  let area=0;
  for(let index=1;index<points.length-1;index++)area+=triangleArea3D([points[0],points[index],points[index+1]]);
  return area;
}

function pointTouchesTriangleEdge(point,triangle,tolerance=1e-7){
  return triangle.some((a,index)=>{
    const b=triangle[(index+1)%triangle.length];
    const dx=b.x-a.x,dy=b.y-a.y;
    const length=Math.hypot(dx,dy);
    return length>0&&Math.abs(dx*(point.y-a.y)-dy*(point.x-a.x))/length<=tolerance;
  });
}

function insetPolygon2D(points,clearance=0.001){
  const centroid=points.reduce((sum,point)=>({
    x:sum.x+point.x/points.length,
    y:sum.y+point.y/points.length,
  }),{x:0,y:0});
  return points.map(point=>{
    const dx=centroid.x-point.x,dy=centroid.y-point.y;
    const distance=Math.hypot(dx,dy);
    const shift=Math.min(clearance,distance*.01);
    return distance>0?{x:point.x+dx/distance*shift,y:point.y+dy/distance*shift}:{...point};
  });
}

function isPitchedExteriorRoof(surface) {
  return surface.type==='RoofCeiling'&&surface.boundary==='Outdoors'
    &&surface.roof?.type&&surface.roof.type!=='flat'&&+(surface.roof.ridgeHeight||0)>0;
}

function expandPitchedRoofs(sourceSurfaces, warnings) {
  const surfaces=[];
  const roofMetricsByZone=new Map();
  for(const surface of sourceSurfaces){
    if(!isPitchedExteriorRoof(surface)){surfaces.push(surface);continue;}
    const built=buildPitchedRoofGeometry(surface);
    if(!built.roofTriangles.length){surfaces.push(surface);continue;}
    roofMetricsByZone.set(surface.zoneId,(roofMetricsByZone.get(surface.zoneId)||0)+built.extraVolume);

    const hostFootprint=surface.roof?.hostFootprint||[];
    const clippedToThermalZone=hostFootprint.length>=3&&
      horizontalGeometryKey(hostFootprint)!==horizontalGeometryKey(surface.footprint||[]);
    const facetPolygons=clippedToThermalZone&&!(surface.skylights||[]).length
      ?mergeClippedCoplanarRoofTriangles(built.roofTriangles)
      :built.roofTriangles;
    const facets=facetPolygons.map((polygon,index)=>({
      ...surface,
      id:`${surface.id}:facet:${String(index+1).padStart(2,'0')}`,
      footprint:polygon.map(p=>({x:p.x,y:p.y})),
      vertices3d:polygon.map(p=>({...p})),
      area:polygonArea3D(polygon),
      skylights:[],
      _pitchedRoofParentId:surface.id,
    }));

    for(const sk of surface.skylights||[]){
      if(sk.isVoid){
        warnings.push({type:'void-not-modeled',surfaceId:surface.id,skylightId:sk.id});
        continue;
      }
      const energyPts=skylightRectangle(sk,warnings);
      const clipped=[];
      built.roofTriangles.forEach((triangle,facetIndex)=>{
        const polygon=clipPolygonToTriangle2D(energyPts,triangle);
        if(!polygon.length)return;
        const parts=polygon.length<=4?[polygon]:polygon.slice(1,-1).map((point,index)=>[polygon[0],point,polygon[index+2]]);
        parts.filter(part=>Math.abs(shoelaceArea(part))>1e-8).forEach(part=>{
          const projectedArea=Math.abs(shoelaceArea(part));
          const points=part.some(point=>pointTouchesTriangleEdge(point,triangle))?insetPolygon2D(part):part;
          clipped.push({facetIndex,triangle,points,projectedArea});
        });
      });
      if(!clipped.length){
        warnings.push({type:'skylight-outside-pitched-roof',skylightId:sk.id,surfaceId:surface.id});
        continue;
      }
      const facetCount=new Set(clipped.map(fragment=>fragment.facetIndex)).size;
      if(facetCount>1)warnings.push({
        type:'skylight-split-across-pitched-roof-facets',
        skylightId:sk.id,
        surfaceId:surface.id,
        fragmentCount:clipped.length,
      });
      const sourceArea=Math.abs(shoelaceArea(energyPts));
      const clippedArea=clipped.reduce((sum,fragment)=>sum+fragment.projectedArea,0);
      if(sourceArea>1e-8&&clippedArea<sourceArea-1e-7)warnings.push({
        type:'skylight-clipped-to-pitched-roof',
        skylightId:sk.id,
        surfaceId:surface.id,
        projectedArea:sourceArea,
        exportedProjectedArea:clippedArea,
      });
      clipped.forEach((fragment,index)=>{
        const ordered=shoelaceArea(fragment.points)>=0?fragment.points:[...fragment.points].reverse();
        facets[fragment.facetIndex].skylights.push({
          ...sk,
          id:clipped.length===1?sk.id:`${sk.id||`${surface.id}:skylight`}:fragment:${String(index+1).padStart(2,'0')}`,
          _pitchedSkylightParentId:sk.id??null,
          _energyVertices3d:ordered.map(p=>({x:p.x,y:p.y,z:planeZAtPoint(fragment.triangle,p)})),
        });
      });
    }
    surfaces.push(...facets);
    // env_studio promotes closures into first-class BTM Wall surfaces before
    // export. Standalone callers may still supply only a pitched roof, so the
    // adapter materialises equivalent hosts here as a compatibility path.
    const materialized=sourceSurfaces.some(candidate=>
      candidate.type==='Wall'&&candidate._pitchedRoofParentId===surface.id);
    if(!materialized){
      (built.closureSurfaces||[]).forEach((closure,index)=>{
        const closureWall={
          id:`${surface.id}:closure:e${String(closure.edgeIndex).padStart(2,'0')}:s${String(index).padStart(2,'0')}`,
          type:'Wall',
          zoneId:surface.zoneId,
          boundary:'Outdoors',
          adjacentSurfaceId:null,
          p1:{...closure.p1},p2:{...closure.p2},
          zBase:closure.zBase,
          bottomZ1:closure.zBase,bottomZ2:closure.zBase,
          height:Math.max(closure.topZ1,closure.topZ2)-closure.zBase,
          topZ1:closure.topZ1,topZ2:closure.topZ2,
          vertices3d:closure.vertices3d.map(p=>({...p})),
          area:closure.area,
          sourceBlockId:surface.sourceBlockId??null,
          sourceEdgeIdx:closure.edgeIndex,
          windows:[],
          _roofClosure:true,
          _pitchedRoofParentId:surface.id,
        };
        for(const opening of surface.closureOpenings||[]){
          if(opening.parentEdgeIdx!=null&&opening.parentEdgeIdx!==closure.edgeIndex)continue;
          if(roofClosureOpeningFits(closure,opening))closureWall.windows.push({...opening});
          else warnings.push({type:'roof-closure-opening-outside-host',openingId:opening.id,surfaceId:closureWall.id});
        }
        surfaces.push(closureWall);
      });
    }
  }
  return {surfaces,roofMetricsByZone};
}

export function btmToEpjson(btm, opts = {}) {
  const {
    trueNorth = btm.site?.trueNorth ?? 0,
    anchor = null,
    materials = { ceiling: 0.80, walls: 0.50, floor: 0.20 },
    glazingVT = 0.75,
    constructions = {},
    constructionLibrary = {},
    energyProps = {},
    schedules = {},
    location = null,
    timestep = 6,
    solarDistribution = 'FullExterior',
    shadingPolygons = [],
    surfaceExposureOverride = null,
    referenceInfiltration = false,
    comfortModel = null,
    groundTemperature = 18.0, // D-4 default; test-only override hook (Gate P2)
  } = opts;

  if (!location) throw new Error('btmToEpjson requires opts.location from parseEpwLocation(epw)');
  const zones = [...(btm.zones || [])].filter(z => z.height > 0).sort((a, b) => sanitize(a.id).localeCompare(sanitize(b.id)));
  if (!zones.length) throw new Error('btmToEpjson: no zones with height > 0');
  const zoneById = new Map(zones.map(z => [z.id, z]));
  const trueAnchor = anchor || buildingAnchor(zones);
  const warnings = [];
  const defaulted = [];
  const surfaceManifest = [];
  const globalSchedules = normalizeEnergySchedules(schedules);
  const airBoundaryExpanded = expandInterzoneAirBoundaries(
    [...(btm.surfaces || [])], warnings, defaulted);
  const expanded=expandPitchedRoofs(airBoundaryExpanded,warnings);
  const expandedSurfaces=expandNonConvexHorizontalSurfaces(expanded.surfaces,warnings)
    .sort((a,b)=>sanitize(a.id).localeCompare(sanitize(b.id)));
  const energyVerticesBySurface=new Map();
  const omittedSurfaces=new Set();
  expandedSurfaces.forEach(surface=>{
    const cleaned=cleanEnergyVertices(surfaceVertices(surface,trueNorth,trueAnchor));
    energyVerticesBySurface.set(surface,cleaned);
    if(cleaned.length<3)omittedSurfaces.add(surface);
  });
  const expandedById=new Map(expandedSurfaces.map(surface=>[surface.id,surface]));
  const synchronizedPairs=new Set();
  expandedSurfaces.forEach(surface=>{
    if(surface.boundary!=='Surface'||synchronizedPairs.has(surface))return;
    const adjacent=expandedById.get(surface.adjacentSurfaceId);
    if(!adjacent)return;
    const primary=sanitize(surface.id).localeCompare(sanitize(adjacent.id))<=0?surface:adjacent;
    const secondary=primary===surface?adjacent:surface;
    const shared=cleanEnergyVertices(surfaceVertices(primary,trueNorth,trueAnchor));
    energyVerticesBySurface.set(primary,shared);
    energyVerticesBySurface.set(secondary,[...shared].reverse().map(entry=>({...entry})));
    if(shared.length<3){omittedSurfaces.add(primary);omittedSurfaces.add(secondary);}
    else{omittedSurfaces.delete(primary);omittedSurfaces.delete(secondary);}
    synchronizedPairs.add(primary);synchronizedPairs.add(secondary);
  });
  // Reciprocal boundaries are atomic: if one sub-tolerance side is omitted,
  // omit its exact mate too so no dangling Surface object can be exported.
  let omissionChanged=true;
  while(omissionChanged){
    omissionChanged=false;
    expandedSurfaces.forEach(surface=>{
      if(surface.boundary!=='Surface')return;
      const adjacent=expandedById.get(surface.adjacentSurfaceId);
      if(omittedSurfaces.has(surface)||omittedSurfaces.has(adjacent)){
        if(!omittedSurfaces.has(surface)){omittedSurfaces.add(surface);omissionChanged=true;}
        if(adjacent&&!omittedSurfaces.has(adjacent)){omittedSurfaces.add(adjacent);omissionChanged=true;}
      }
    });
  }
  omittedSurfaces.forEach(surface=>defaulted.push({
    surfaceId:surface.id,
    field:'energyGeometry',
    value:`omitted below ${ENERGYPLUS_VERTEX_TOLERANCE_M} m vertex tolerance`,
  }));
  const surfaces=expandedSurfaces.filter(surface=>!omittedSurfaces.has(surface));
  const roofMetricsByZone=expanded.roofMetricsByZone;
  const airBoundaryFloorAreaByZone = new Map();
  for (const surface of surfaces) {
    if (!surface._airBoundary || surface.type !== 'Floor') continue;
    airBoundaryFloorAreaByZone.set(surface.zoneId,
      (airBoundaryFloorAreaByZone.get(surface.zoneId) || 0) + Math.abs(shoelaceArea(surface.footprint)));
  }
  const conditionedFloorAreaByZone = {};

  const epjson = {
    Version: { Version: { version_identifier: '26.1' } },
    SimulationControl: {
      SimulationControl: {
        do_zone_sizing_calculation: 'No',
        do_system_sizing_calculation: 'No',
        do_plant_sizing_calculation: 'No',
        run_simulation_for_sizing_periods: 'No',
        run_simulation_for_weather_file_run_periods: 'Yes',
      },
    },
    Building: {
      Building: {
        north_axis: 0,
        terrain: 'City',
        solar_distribution: solarDistribution,
        maximum_number_of_warmup_days: 40,
        minimum_number_of_warmup_days: 6,
      },
    },
    Timestep: { Timestep: { number_of_timesteps_per_hour: timestep } },
    RunPeriod: {
      Annual: {
        begin_month: 1,
        begin_day_of_month: 1,
        end_month: 12,
        end_day_of_month: 31,
        use_weather_file_holidays_and_special_days: 'Yes',
        use_weather_file_daylight_saving_period: 'Yes',
        apply_weekend_holiday_rule: 'No',
        use_weather_file_rain_indicators: 'Yes',
        use_weather_file_snow_indicators: 'Yes',
      },
    },
    'Site:Location': {
      [location.name || 'EPW Location']: {
        latitude: location.latitude,
        longitude: location.longitude,
        time_zone: location.timeZone,
        elevation: location.elevation,
      },
    },
    GlobalGeometryRules: {
      GlobalGeometryRules: {
        starting_vertex_position: 'UpperLeftCorner',
        vertex_entry_direction: 'Counterclockwise',
        coordinate_system: 'Relative',
      },
    },
    'Site:GroundTemperature:BuildingSurface': {
      GroundTemps: Object.fromEntries([
        'january', 'february', 'march', 'april', 'may', 'june',
        'july', 'august', 'september', 'october', 'november', 'december',
      ].map(m => [`${m}_ground_temperature`, groundTemperature])),
    },
    ScheduleTypeLimits: {
      Fraction: { lower_limit_value: 0, upper_limit_value: 1, numeric_type: 'Continuous', unit_type: 'Dimensionless' },
      Temperature: { numeric_type: 'Continuous', unit_type: 'Temperature' },
      ControlType: { lower_limit_value: 0, upper_limit_value: 4, numeric_type: 'Discrete', unit_type: 'Control' },
      Activity: { numeric_type: 'Continuous', unit_type: 'ActivityLevel' },
    },
    'Schedule:Compact': {
      Sched_Occupancy: occupancySchedule(),
      Sched_AlwaysOn: alwaysSchedule(1),
      Sched_Activity: alwaysSchedule(comfortModel?.activityLevelWatts ?? 120, 'Activity'),
      Sched_ControlType: alwaysSchedule(4, 'ControlType'),
      ...(comfortModel ? {
        Sched_ComfortWorkEfficiency: alwaysSchedule(comfortModel.workEfficiency ?? 0),
        Sched_ComfortClothing: alwaysSchedule(comfortModel.clothing ?? 0.7),
        Sched_ComfortAirVelocity: alwaysSchedule(comfortModel.airVelocity ?? 0.1),
      } : {}),
    },
    Zone: {},
    Material: {},
    'Material:NoMass': {},
    'Material:AirGap': {},
    'WindowMaterial:SimpleGlazingSystem': {},
    Construction: {},
    'Construction:AirBoundary': {},
    'BuildingSurface:Detailed': {},
    'FenestrationSurface:Detailed': {},
    People: {},
    Lights: {},
    ElectricEquipment: {},
    'ZoneInfiltration:DesignFlowRate': {},
    'ZoneVentilation:WindandStackOpenArea': {},
    'DesignSpecification:OutdoorAir': {},
    'ZoneControl:Thermostat': {},
    'ThermostatSetpoint:DualSetpoint': {},
    'ZoneHVAC:IdealLoadsAirSystem': {},
    'ZoneHVAC:EquipmentList': {},
    'ZoneHVAC:EquipmentConnections': {},
    NodeList: {},
    'Output:Variable': {},
    'Output:Table:SummaryReports': {
      AllSummary: { reports: [{ report_name: 'AllSummary' }] },
    },
    'OutputControl:Table:Style': {
      Comma: { column_separator: 'Comma' },
    },
  };

  const resolveOpaqueSpec = (key, spec) => spec?.mode === 'assembly'
    ? assemblyToConstructionSpec(spec.assemblyId, constructionLibrary)
    : spec;
  const resolvedGlobalConstructions = Object.fromEntries(Object.entries(constructions)
    .filter(([key]) => key !== 'window' && key !== 'skylight')
    .map(([key, spec]) => [key, resolveOpaqueSpec(key, spec)]));
  const constructionSpecs = mergeConstructionDefaults(resolvedGlobalConstructions, materials);
  for (const [key, definition] of Object.entries(OPAQUE_CONSTRUCTION_DEFINITIONS)) {
    addOpaqueConstruction(epjson, key, constructionSpecs[key], definition);
  }

  // Per-zone construction overrides receive unique EnergyPlus object names,
  // while untouched types continue to reference the building-wide objects.
  const constructionNamesByZone = new Map();
  for (const zone of zones) {
    const names = Object.fromEntries(Object.entries(OPAQUE_CONSTRUCTION_DEFINITIONS)
      .map(([key, definition]) => [key, definition.constructionName]));
    for (const [key, override] of Object.entries(zone.constructions || {})) {
      const baseDefinition = OPAQUE_CONSTRUCTION_DEFINITIONS[key];
      if (!baseDefinition || !override || typeof override !== 'object') continue;
      // A zone can override only the air-volume thickness while continuing to
      // inherit its building construction. In that case there is no reason to
      // emit a duplicate EnergyPlus construction with identical thermal data.
      if (!Object.keys(override).some(field => field !== 'thicknessOverride')) continue;
      const resolvedOverride = resolveOpaqueSpec(key, override);
      const zoneToken = sanitize(zone.id);
      const definition = {
        materialName:`${baseDefinition.materialName}_${zoneToken}`,
        constructionName:`${baseDefinition.constructionName}_${zoneToken}`,
        filmKey:baseDefinition.filmKey,
      };
      const effective = {
        ...constructionSpecs[key],
        ...resolvedOverride,
        ...(Array.isArray(resolvedOverride.layers) ? { layers:resolvedOverride.layers.map(layer => ({...layer})) } : {}),
      };
      names[key] = addOpaqueConstruction(epjson, `${zone.id} ${key}`, effective, definition);
    }
    constructionNamesByZone.set(zone.id, names);
  }

  // A wall-authored assembly is the narrowest construction scope and takes
  // precedence over both zone and model assignments. Identical local
  // assembly/type pairs share EnergyPlus material and construction objects.
  const constructionNamesBySurface = new Map();
  const localWallConstructions = new Map();
  for (const surf of surfaces) {
    if (surf.type !== 'Wall' || !surf.energyAssemblyId) continue;
    const key = constructionKeyForSurface(surf);
    const baseDefinition = OPAQUE_CONSTRUCTION_DEFINITIONS[key];
    if (!baseDefinition) continue;
    const cacheKey = `${key}:${surf.energyAssemblyId}`;
    let constructionName = localWallConstructions.get(cacheKey);
    if (!constructionName) {
      const resolvedOverride = resolveOpaqueSpec(key,
        { mode:'assembly', assemblyId:surf.energyAssemblyId });
      const token = sanitize(`${key}_${surf.energyAssemblyId}`);
      const definition = {
        materialName:`${baseDefinition.materialName}_WallOverride_${token}`,
        constructionName:`${baseDefinition.constructionName}_WallOverride_${token}`,
        filmKey:baseDefinition.filmKey,
      };
      const effective = {
        ...constructionSpecs[key],
        ...resolvedOverride,
        ...(Array.isArray(resolvedOverride.layers)
          ? { layers:resolvedOverride.layers.map(layer => ({ ...layer })) } : {}),
      };
      constructionName = addOpaqueConstruction(epjson, `wall ${key} ${surf.energyAssemblyId}`, effective, definition);
      localWallConstructions.set(cacheKey, constructionName);
    }
    constructionNamesBySurface.set(surf.id, constructionName);
  }

  const localDoorConstructions = new Map();
  for (const surface of surfaces) for (const opening of surface.windows || []) {
    if (opening.subtype !== 'door' || !opening.energyAssemblyId || localDoorConstructions.has(opening.energyAssemblyId)) continue;
    const id=opening.energyAssemblyId;
    const effective=resolveOpaqueSpec('door',{mode:'assembly',assemblyId:id});
    const token=sanitize(id);
    const definition={materialName:`Material_Door_Opening_${token}`,constructionName:`Construction_Door_Opening_${token}`,filmKey:'wall'};
    localDoorConstructions.set(id,addOpaqueConstruction(epjson,`door ${id}`,effective,definition));
  }

  const globalWindowSpec = constructions.window?.mode === 'assembly'
    ? assemblyToWindowSpec(constructions.window.assemblyId, constructionLibrary)
    : null;
  const windowSpecByZone = new Map(zones.map(zone => {
    const override = zone.constructions?.window;
    const spec = override?.mode === 'assembly'
      ? assemblyToWindowSpec(override.assemblyId, constructionLibrary)
      : globalWindowSpec;
    return [zone.id, spec];
  }));
  const skylightSpecByZone = new Map(zones.map(zone => {
    const assignment = zone.constructions?.skylight || constructions.skylight;
    return [zone.id, assignment?.assemblyId
      ? assemblyToWindowSpec(assignment.assemblyId, constructionLibrary)
      : windowSpecByZone.get(zone.id)];
  }));
  const effectiveGlazing = (surf, source = {}, kind = 'window') => {
    const inheritedSpec = (kind === 'skylight' ? skylightSpecByZone : windowSpecByZone).get(surf.zoneId) || {};
    return resolveEffectiveWindowSpec(source, inheritedSpec, constructionLibrary);
  };

  const glazingTriples = new Map();
  for (const surf of surfaces) {
    for (const win of surf.windows || []) {
      if (win.subtype === 'door' || isWallVoid(win)) continue;
      const effectiveWindow = effectiveGlazing(surf, win);
      const key = glazingKey(effectiveWindow, glazingVT);
      if (!glazingTriples.has(key)) glazingTriples.set(key, { win:effectiveWindow, key });
    }
    for (const sk of surf.skylights || []) {
      if (sk.isVoid) continue;
      const effectiveSkylight = effectiveGlazing(surf, { ...sk, uValue:sk.uValue ?? 2.0, shgc:sk.shgc ?? 0.40, vt:sk.glazingVT ?? glazingVT }, 'skylight');
      const key = glazingKey(effectiveSkylight, glazingVT);
      if (!glazingTriples.has(key)) glazingTriples.set(key, { win:effectiveSkylight, key });
    }
  }
  [...glazingTriples.keys()].sort().forEach((key, i) => {
    const { win } = glazingTriples.get(key);
    const matName = `WindowMaterial_Simple_${i + 1}`;
    const conName = `Construction_Window_${i + 1}`;
    epjson['WindowMaterial:SimpleGlazingSystem'][matName] = {
      u_factor: win.uValue ?? 2.0,
      solar_heat_gain_coefficient: win.shgc ?? 0.40,
      visible_transmittance: win.vt ?? glazingVT,
    };
    epjson.Construction[conName] = { outside_layer: matName };
    glazingTriples.get(key).constructionName = conName;
  });

  const hasExteriorRoofOpening = surfaces.some(surface =>
    surface.type === 'RoofCeiling' && surface.boundary === 'Outdoors' &&
    (surface.skylights || []).some(opening => opening.isVoid));
  if (hasExteriorRoofOpening) {
    // EnergyPlus requires an exterior opening to remain a heat-transfer
    // subsurface. This near-adiabatic, fully solar-transmitting carrier keeps
    // aperture heat transfer in the ventilation model instead of double
    // counting it as glazing conduction.
    epjson['WindowMaterial:SimpleGlazingSystem'][OPEN_ROOF_APERTURE_MATERIAL] = {
      u_factor:0.1,
      solar_heat_gain_coefficient:0.999,
      visible_transmittance:0.999,
    };
    epjson.Construction[OPEN_ROOF_APERTURE_CONSTRUCTION] = {
      outside_layer:OPEN_ROOF_APERTURE_MATERIAL,
    };
  }
  const hasExteriorWallOpening = surfaces.some(surface =>
    surface.type === 'Wall' && surface.boundary === 'Outdoors' &&
    (surface.windows || []).some(isWallVoid));
  if (hasExteriorWallOpening) {
    epjson['WindowMaterial:SimpleGlazingSystem'][OPEN_WALL_APERTURE_MATERIAL] = {
      u_factor:0.1,
      solar_heat_gain_coefficient:0.999,
      visible_transmittance:0.999,
    };
    epjson.Construction[OPEN_WALL_APERTURE_CONSTRUCTION] = {
      outside_layer:OPEN_WALL_APERTURE_MATERIAL,
    };
  }

  const airBoundaryConstructionNames = new Map();
  const airBoundaryConfigKey = config => config.airflowMode === 'none'
    ? 'none' : `simpleMixing|${snap9(config.simpleMixingACH)}`;
  for (const surface of surfaces) {
    if (!surface._airBoundary) continue;
    const config = surface._airBoundary;
    const key = airBoundaryConfigKey(config);
    if (airBoundaryConstructionNames.has(key)) continue;
    const name = config.airflowMode === 'none'
      ? 'Construction_AirBoundary_None'
      : `Construction_AirBoundary_Mixing_${String(snap9(config.simpleMixingACH)).replace('.', '_')}_ACH`;
    epjson['Construction:AirBoundary'][name] = config.airflowMode === 'none' ? {
      air_exchange_method:'None',
    } : {
      air_exchange_method:'SimpleMixing',
      simple_mixing_air_changes_per_hour:snap9(config.simpleMixingACH),
      simple_mixing_schedule_name:'Sched_AlwaysOn',
    };
    airBoundaryConstructionNames.set(key, name);
  }

  for (const z of zones) {
    const name = sanitize(z.id);
    const roofVolume = roofMetricsByZone.get(z.id) || 0;
    const geometricVolume = z.volume + roofVolume;
    // Zone geometry is authored floor-finish level to floor-finish level. A
    // horizontal construction at the TOP of the zone occupies part of that
    // interval, while the reciprocal floor belongs below the upper zone's FFL
    // and must not be subtracted a second time. Summing each ceiling fragment
    // also gives the correct area-weighted result for partial stacks and mixed
    // roof/interior-slab ceilings.
    const upperConstructionVolume = surfaces.reduce((total, surface) => {
      if (surface.zoneId !== z.id || surface.type !== 'RoofCeiling' || surface._airBoundary) return total;
      const key = constructionKeyForSurface(surface);
      const local = z.constructions?.[key];
      const assignment = local && Object.prototype.hasOwnProperty.call(local, 'thicknessOverride')
        ? local : constructions[key];
      const rawThickness = Number(assignment?.thicknessOverride);
      const thickness = Number.isFinite(rawThickness) ? Math.max(0, rawThickness) : 0;
      if (thickness === 0) return total;
      const vertices = energyVerticesBySurface.get(surface)
        || cleanEnergyVertices(surfaceVertices(surface, trueNorth, trueAnchor));
      return total + areaOfVertices(vertices) * thickness;
    }, 0);
    // IFC-space zones are expanded from finish faces to wall centrelines so
    // adjacent zones share one thermal boundary. A wall therefore occupies
    // half its construction thickness inside each zone. Deduct the resulting
    // plan strips from floor area, then apply the already calculated clear
    // height; this avoids double-counting the wall/slab corner volume.
    const wallStrips = new Map();
    for (const surface of surfaces) {
      if (surface.zoneId !== z.id || surface.type !== 'Wall' || surface._airBoundary) continue;
      const key = constructionKeyForSurface(surface);
      const local = z.constructions?.[key];
      const assignment = local && Object.prototype.hasOwnProperty.call(local, 'thicknessOverride')
        ? local : constructions[key];
      const rawThickness = Number(assignment?.thicknessOverride);
      const thickness = Number.isFinite(rawThickness) ? Math.max(0, rawThickness) : 0;
      if (thickness === 0 || !surface.p1 || !surface.p2) continue;
      const a = `${snap9(surface.p1.x)},${snap9(surface.p1.y)}`;
      const b = `${snap9(surface.p2.x)},${snap9(surface.p2.y)}`;
      const edgeKey = a < b ? `${a}|${b}` : `${b}|${a}`;
      const stripArea = Math.hypot(surface.p2.x - surface.p1.x, surface.p2.y - surface.p1.y) * thickness / 2;
      wallStrips.set(edgeKey, Math.max(wallStrips.get(edgeKey) || 0, stripArea));
    }
    const wallPlanArea = [...wallStrips.values()].reduce((sum, area) => sum + area, 0);
    const clearVolumeBeforeWalls = Math.max(0, geometricVolume - upperConstructionVolume);
    const clearHeightBeforeWalls = z.floorArea > 0 ? clearVolumeBeforeWalls / z.floorArea : 0;
    const netFloorArea = Math.max(0, z.floorArea - wallPlanArea);
    const wallConstructionVolume = (z.floorArea - netFloorArea) * clearHeightBeforeWalls;
    const totalConstructionVolume = upperConstructionVolume + wallConstructionVolume;
    if (totalConstructionVolume > geometricVolume + 1e-9) {
      warnings.push({
        type:'construction-thickness-exceeds-zone-volume', zoneId:z.id,
        geometricVolume:snap9(geometricVolume), deductedVolume:snap9(totalConstructionVolume),
      });
    }
    const conditionedVolume = Math.max(0, clearVolumeBeforeWalls - wallConstructionVolume);
    const meanCeilingHeight = netFloorArea > 0 ? conditionedVolume / netFloorArea : 0;
    const conditionedFloorArea = snap9(Math.max(0,
      netFloorArea - (airBoundaryFloorAreaByZone.get(z.id) || 0)));
    conditionedFloorAreaByZone[z.id] = conditionedFloorArea;
    epjson.Zone[name] = {
      direction_of_relative_north: 0,
      x_origin: 0,
      y_origin: 0,
      z_origin: 0,
      type: 1,
      multiplier: 1,
      ceiling_height: snap9(meanCeilingHeight),
      volume: snap9(conditionedVolume),
      floor_area: conditionedFloorArea,
    };

    const props = mergeEnergyProps(z.energyProps, energyProps['*'] || {});
    const zoneOverride = energyProps[z.id] || energyProps[name] || {};
    Object.assign(props, zoneOverride);
    if (props.hvacType !== 'ideal') throw new Error(`Unsupported hvacType "${props.hvacType}" for ${z.id}; supported: ideal`);
    for (const [field, value] of Object.entries(DEFAULT_ENERGY_PROPS)) {
      if (z.energyProps?.[field] === undefined && zoneOverride[field] === undefined && energyProps['*']?.[field] === undefined) {
        addDefault(defaulted, { zoneId: z.id }, field, value);
      }
    }

    const heatSched = `${name}_Sched_HeatSet`;
    const coolSched = `${name}_Sched_CoolSet`;
    epjson['Schedule:Compact'][heatSched] = alwaysSchedule(props.setpointHeating, 'Temperature');
    epjson['Schedule:Compact'][coolSched] = alwaysSchedule(props.setpointCooling, 'Temperature');
    const zoneSchedules = {};
    const zoneScheduleSpecs = {};
    for (const key of ENERGY_SCHEDULE_KEYS) {
      const spec = z.schedules?.[key]
        ? normalizeEnergyScheduleSpec(z.schedules[key], key)
        : globalSchedules[key];
      const scheduleName = `${name}_Sched_${key[0].toUpperCase()}${key.slice(1)}`;
      epjson['Schedule:Compact'][scheduleName] = compactSchedule('Fraction', energyScheduleCompactFields(spec, key));
      zoneSchedules[key] = scheduleName;
      zoneScheduleSpecs[key] = spec;
    }

    epjson.People[`${name}_People`] = {
      zone_or_zonelist_or_space_or_spacelist_name: name,
      number_of_people_schedule_name: zoneSchedules.occupancy,
      number_of_people_calculation_method: 'People/Area',
      people_per_floor_area: props.occupancyDensity,
      fraction_radiant: 0.3,
      sensible_heat_fraction: 'Autocalculate',
      activity_level_schedule_name: 'Sched_Activity',
      ...(comfortModel ? {
        work_efficiency_schedule_name: 'Sched_ComfortWorkEfficiency',
        clothing_insulation_calculation_method: 'ClothingInsulationSchedule',
        clothing_insulation_schedule_name: 'Sched_ComfortClothing',
        air_velocity_schedule_name: 'Sched_ComfortAirVelocity',
        thermal_comfort_model_1_type: 'Fanger',
      } : {}),
    };
    epjson.Lights[`${name}_Lights`] = {
      zone_or_zonelist_or_space_or_spacelist_name: name,
      schedule_name: zoneSchedules.lighting,
      design_level_calculation_method: 'Watts/Area',
      watts_per_floor_area: props.lightingPowerDensity,
      return_air_fraction: 0,
      fraction_radiant: 0.42,
      fraction_visible: 0.18,
      fraction_replaceable: 1,
    };
    epjson.ElectricEquipment[`${name}_Equipment`] = {
      zone_or_zonelist_or_space_or_spacelist_name: name,
      schedule_name: zoneSchedules.equipment,
      design_level_calculation_method: 'Watts/Area',
      watts_per_floor_area: props.equipmentPowerDensity,
      fraction_latent: 0,
      fraction_radiant: 0.3,
      fraction_lost: 0,
    };
    let infiltrationSchedule = 'Sched_AlwaysOn';
    let infiltrationAch = props.infiltrationACH;
    if (referenceInfiltration) {
      infiltrationSchedule = `${name}_Sched_NccReferenceInfiltration`;
      const source = resolveEnergySchedule(zoneScheduleSpecs.hvac, 'hvac');
      const mapProfile = values => values.map(value => Number(value) > 0 ? 0.35 : 0.70);
      const referenceSpec = normalizeEnergyScheduleSpec({
        preset:'custom',
        weekday:mapProfile(source.weekday),
        saturday:mapProfile(source.saturday),
        sunday:mapProfile(source.sunday),
      }, 'hvac');
      epjson['Schedule:Compact'][infiltrationSchedule] = compactSchedule(
        'Fraction', energyScheduleCompactFields(referenceSpec, 'hvac'));
      // The schedule itself carries the S34C3 air-change values.
      infiltrationAch = 1;
    }
    epjson['ZoneInfiltration:DesignFlowRate'][`${name}_Infiltration`] = {
      zone_or_zonelist_or_space_or_spacelist_name: name,
      schedule_name: infiltrationSchedule,
      design_flow_rate_calculation_method: 'AirChanges/Hour',
      air_changes_per_hour: infiltrationAch,
      constant_term_coefficient: 1,
      temperature_term_coefficient: 0,
      velocity_term_coefficient: 0,
      velocity_squared_term_coefficient: 0,
    };
    epjson['DesignSpecification:OutdoorAir'][`${name}_OA`] = {
      outdoor_air_method: 'Flow/Person',
      outdoor_air_flow_per_person: props.outdoorAirRate / 1000,
      outdoor_air_schedule_name: zoneSchedules.hvac,
    };

    const airNode = `${name}_Air_Node`;
    const supplyNode = `${name}_Supply_Node`;
    const exhaustNode = `${name}_Exhaust_Node`;
    const inletList = `${name}_Inlet_Nodes`;
    const exhaustList = `${name}_Exhaust_Nodes`;
    Object.assign(epjson.NodeList, makeNodeList(inletList, supplyNode), makeNodeList(exhaustList, exhaustNode));
    epjson['ThermostatSetpoint:DualSetpoint'][`${name}_DualSetpoint`] = {
      heating_setpoint_temperature_schedule_name: heatSched,
      cooling_setpoint_temperature_schedule_name: coolSched,
    };
    epjson['ZoneControl:Thermostat'][`${name}_Thermostat`] = {
      zone_or_zonelist_name: name,
      control_type_schedule_name: 'Sched_ControlType',
      control_1_object_type: 'ThermostatSetpoint:DualSetpoint',
      control_1_name: `${name}_DualSetpoint`,
    };
    epjson['ZoneHVAC:IdealLoadsAirSystem'][`${name}_IdealLoads`] = {
      availability_schedule_name: zoneSchedules.hvac,
      zone_supply_air_node_name: supplyNode,
      zone_exhaust_air_node_name: exhaustNode,
      maximum_heating_supply_air_humidity_ratio: 0.015,
      minimum_cooling_supply_air_humidity_ratio: 0.009,
      heating_limit: 'NoLimit',
      cooling_limit: 'NoLimit',
      heating_availability_schedule_name: zoneSchedules.hvac,
      cooling_availability_schedule_name: zoneSchedules.hvac,
      dehumidification_control_type: 'ConstantSupplyHumidityRatio',
      humidification_control_type: 'ConstantSupplyHumidityRatio',
      design_specification_outdoor_air_object_name: `${name}_OA`,
    };
    epjson['ZoneHVAC:EquipmentList'][`${name}_Equipment_List`] = {
      load_distribution_scheme: 'SequentialLoad',
      equipment: [{
        zone_equipment_object_type: 'ZoneHVAC:IdealLoadsAirSystem',
        zone_equipment_name: `${name}_IdealLoads`,
        zone_equipment_cooling_sequence: 1,
        zone_equipment_heating_or_no_load_sequence: 1,
      }],
    };
    epjson['ZoneHVAC:EquipmentConnections'][name] = {
      zone_name: name,
      zone_conditioning_equipment_list_name: `${name}_Equipment_List`,
      zone_air_inlet_node_or_nodelist_name: inletList,
      zone_air_exhaust_node_or_nodelist_name: exhaustList,
      zone_air_node_name: airNode,
    };
  }

  const surfaceById = new Map(surfaces.map(s => [s.id, s]));
  for (const surf of surfaces) {
    if (!zoneById.has(surf.zoneId)) continue;
    if (surf.type !== 'Wall' && surf.type !== 'Floor' && surf.type !== 'RoofCeiling') continue;
    const name = sanitize(surf.id);
    const fields = boundaryFields(surf);
    if (surfaceExposureOverride) {
      fields.sun_exposure = surfaceExposureOverride.sun_exposure ?? fields.sun_exposure;
      fields.wind_exposure = surfaceExposureOverride.wind_exposure ?? fields.wind_exposure;
    }
    const exportedSurfaceVertices = energyVerticesBySurface.get(surf)
      || cleanEnergyVertices(surfaceVertices(surf, trueNorth, trueAnchor));
    epjson['BuildingSurface:Detailed'][name] = {
      surface_type: surfaceType(surf),
      construction_name: surf._airBoundary
        ? airBoundaryConstructionNames.get(airBoundaryConfigKey(surf._airBoundary))
        : constructionNamesBySurface.get(surf.id)
          || constructionNamesByZone.get(surf.zoneId)?.[constructionKeyForSurface(surf)]
          || OPAQUE_CONSTRUCTION_DEFINITIONS[constructionKeyForSurface(surf)].constructionName,
      zone_name: sanitize(surf.zoneId),
      ...fields,
      view_factor_to_ground: 'Autocalculate',
      vertices: exportedSurfaceVertices,
    };
    const modelsExteriorRoofVoids = surf.type === 'RoofCeiling' && surf.boundary === 'Outdoors';
    if (!modelsExteriorRoofVoids && surf.skylights?.some(sk => sk.isVoid)) {
      warnings.push({ type:'void-not-modeled', surfaceId:surf.id });
    }

    const exteriorSolarSurface = surf.boundary === 'Outdoors' && (surf.type === 'Wall' || surf.type === 'RoofCeiling');
    const exportedOpenings = [];

    for (const win of [...(surf.windows || [])].sort((a, b) => sanitize(a.id).localeCompare(sanitize(b.id)))) {
      const winName = sanitize(win.id);
      const isDoor = win.subtype === 'door';
      const isVoid = isWallVoid(win);
      const exteriorVoid = isVoid && surf.boundary === 'Outdoors';
      if (isVoid && !exteriorVoid) {
        warnings.push({ type:'wall-void-not-modeled', surfaceId:surf.id, openingId:win._openingId || win.id });
        continue;
      }
      const effectiveWindow = isDoor || exteriorVoid ? null : effectiveGlazing(surf, win);
      const f = {
        surface_type: isDoor ? 'Door' : 'Window',
        construction_name: exteriorVoid
          ? OPEN_WALL_APERTURE_CONSTRUCTION
          : isDoor
          ? (localDoorConstructions.get(win.energyAssemblyId) || constructionNamesByZone.get(surf.zoneId)?.door || 'Construction_Door')
          : glazingTriples.get(glazingKey(effectiveWindow, glazingVT)).constructionName,
        building_surface_name: name,
        view_factor_to_ground: 'Autocalculate',
        multiplier: 1,
      };
      if (surf.boundary === 'Surface') {
        f.outside_boundary_condition_object = win._adjacentOpeningId
          ? sanitize(win._adjacentOpeningId)
          : sanitize(`win:${surf.adjacentSurfaceId}:${win.id.split(':').at(-1)}`);
      }
      const verts = fenestrationVertices(surf, win, trueNorth, trueAnchor);
      const winAreaM2 = areaOfVertices(verts);
      exportedOpenings.push({ win, name: winName, verts, areaM2: winAreaM2 });
      Object.assign(f, {
        vertex_1_x_coordinate: verts[0].vertex_x_coordinate,
        vertex_1_y_coordinate: verts[0].vertex_y_coordinate,
        vertex_1_z_coordinate: verts[0].vertex_z_coordinate,
        vertex_2_x_coordinate: verts[1].vertex_x_coordinate,
        vertex_2_y_coordinate: verts[1].vertex_y_coordinate,
        vertex_2_z_coordinate: verts[1].vertex_z_coordinate,
        vertex_3_x_coordinate: verts[2].vertex_x_coordinate,
        vertex_3_y_coordinate: verts[2].vertex_y_coordinate,
        vertex_3_z_coordinate: verts[2].vertex_z_coordinate,
        vertex_4_x_coordinate: verts[3].vertex_x_coordinate,
        vertex_4_y_coordinate: verts[3].vertex_y_coordinate,
        vertex_4_z_coordinate: verts[3].vertex_z_coordinate,
      });
      epjson['FenestrationSurface:Detailed'][winName] = f;

      if (exteriorVoid) {
        const config = normalizedOutdoorOpeningConfig(win, zoneById.get(surf.zoneId), defaulted);
        if (config.outdoorAirflowMode === 'windAndStack') {
          const scheduleName = `${winName}_Sched_OpenFraction`;
          const effectiveAngle = surfaceDirection(exportedSurfaceVertices).azimuthDeg ?? 0;
          epjson['Schedule:Compact'][scheduleName] = alwaysSchedule(config.outdoorOpeningFraction);
          epjson['ZoneVentilation:WindandStackOpenArea'][`${winName}_OutdoorFlow`] = {
            zone_or_space_name:sanitize(surf.zoneId),
            opening_area:snap9(winAreaM2),
            opening_area_fraction_schedule_name:scheduleName,
            opening_effectiveness:config.outdoorWindEffectiveness,
            effective_angle:effectiveAngle,
            height_difference:config.outdoorStackHeight,
            discharge_coefficient_for_opening:config.outdoorDischargeCoefficient,
            minimum_indoor_temperature:-100,
            maximum_indoor_temperature:100,
            delta_temperature:-100,
            minimum_outdoor_temperature:-100,
            maximum_outdoor_temperature:100,
            maximum_wind_speed:40,
          };
          warnings.push({
            type:'outdoor-wall-opening-wind-stack-assumption', openingId:win._openingId || win.id,
            areaM2:snap9(winAreaM2), openFraction:config.outdoorOpeningFraction,
            dischargeCoefficient:config.outdoorDischargeCoefficient,
            windEffectiveness:config.outdoorWindEffectiveness,
            stackHeightM:config.outdoorStackHeight,
            effectiveAngleDeg:effectiveAngle,
          });
        } else {
          warnings.push({ type:'outdoor-wall-opening-airflow-disabled', openingId:win._openingId || win.id });
        }
      }
    }

    if (surf.type === 'RoofCeiling') {
      for (const sk of [...(surf.skylights || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        const exteriorVoid = sk.isVoid && surf.boundary === 'Outdoors';
        if (sk.isVoid && !exteriorVoid) continue;
        const effectiveSkylight = exteriorVoid ? null
          : effectiveGlazing(surf, { ...sk, uValue:sk.uValue ?? 2.0, shgc:sk.shgc ?? 0.40, vt:sk.glazingVT ?? glazingVT }, 'skylight');
        const key = exteriorVoid ? null : glazingKey(effectiveSkylight, glazingVT);
        const verts = sk._energyVertices3d
          ? sk._energyVertices3d.map(p => {
              const xy = rotate2D(p, trueNorth, trueAnchor.x, trueAnchor.y);
              return vertex(xy.x, xy.y, p.z);
            })
          : skylightRectangle(sk, warnings, exteriorVoid ? 'roof-opening-approximated' : 'skylight-approximated')
              .map(p => rotate2D(p, trueNorth, trueAnchor.x, trueAnchor.y))
              .map(p => vertex(p.x, p.y, snap9(surf.z)));
        const skName = sanitize(sk.id || `${surf.id}:skylight`);
        const openingAreaM2 = areaOfVertices(verts);
        const fenestration = {
          surface_type: 'Window',
          construction_name: exteriorVoid
            ? OPEN_ROOF_APERTURE_CONSTRUCTION : glazingTriples.get(key).constructionName,
          building_surface_name: name,
          view_factor_to_ground: 'Autocalculate',
          multiplier: 1,
          vertex_1_x_coordinate: verts[0].vertex_x_coordinate,
          vertex_1_y_coordinate: verts[0].vertex_y_coordinate,
          vertex_1_z_coordinate: verts[0].vertex_z_coordinate,
          vertex_2_x_coordinate: verts[1].vertex_x_coordinate,
          vertex_2_y_coordinate: verts[1].vertex_y_coordinate,
          vertex_2_z_coordinate: verts[1].vertex_z_coordinate,
          vertex_3_x_coordinate: verts[2].vertex_x_coordinate,
          vertex_3_y_coordinate: verts[2].vertex_y_coordinate,
          vertex_3_z_coordinate: verts[2].vertex_z_coordinate,
        };
        if(verts.length===3)fenestration.number_of_vertices=3;
        else Object.assign(fenestration,{
          vertex_4_x_coordinate: verts[3].vertex_x_coordinate,
          vertex_4_y_coordinate: verts[3].vertex_y_coordinate,
          vertex_4_z_coordinate: verts[3].vertex_z_coordinate,
        });
        epjson['FenestrationSurface:Detailed'][skName] = fenestration;
        exportedOpenings.push({ win:sk, name:skName, verts, areaM2:openingAreaM2, isSkylight:!exteriorVoid });

        if (exteriorVoid) {
          const config = normalizedOutdoorOpeningConfig(sk, zoneById.get(surf.zoneId), defaulted);
          if (config.outdoorAirflowMode === 'windAndStack') {
            const scheduleName = `${skName}_Sched_OpenFraction`;
            epjson['Schedule:Compact'][scheduleName] = alwaysSchedule(config.outdoorOpeningFraction);
            epjson['ZoneVentilation:WindandStackOpenArea'][`${skName}_OutdoorFlow`] = {
              zone_or_space_name:sanitize(surf.zoneId),
              opening_area:snap9(openingAreaM2),
              opening_area_fraction_schedule_name:scheduleName,
              opening_effectiveness:config.outdoorWindEffectiveness,
              effective_angle:0,
              height_difference:config.outdoorStackHeight,
              discharge_coefficient_for_opening:config.outdoorDischargeCoefficient,
              minimum_indoor_temperature:-100,
              maximum_indoor_temperature:100,
              delta_temperature:-100,
              minimum_outdoor_temperature:-100,
              maximum_outdoor_temperature:100,
              maximum_wind_speed:40,
            };
            warnings.push({
              type:'outdoor-roof-opening-wind-stack-assumption', openingId:sk.id,
              areaM2:snap9(openingAreaM2), openFraction:config.outdoorOpeningFraction,
              dischargeCoefficient:config.outdoorDischargeCoefficient,
              windEffectiveness:config.outdoorWindEffectiveness,
              stackHeightM:config.outdoorStackHeight,
            });
          } else {
            warnings.push({ type:'outdoor-roof-opening-airflow-disabled', openingId:sk.id });
          }
        }
      }
    }

    const envelopeHeatSurface = surf.boundary === 'Outdoors' || surf.boundary === 'Ground';
    if (envelopeHeatSurface) {
      const direction = surfaceDirection(exportedSurfaceVertices);
      const grossAreaM2 = areaOfVertices(exportedSurfaceVertices);
      const openingAreaM2 = exportedOpenings.reduce((sum, opening) => sum + opening.areaM2, 0);
      surfaceManifest.push({
        epName: name,
        sourceId: surf.type === 'RoofCeiling' && surf._pitchedRoofParentId ? surf._pitchedRoofParentId : surf.id,
        exportedId: surf.id,
        zoneId: surf.zoneId,
        kind: 'surface',
        assembly: surf.type === 'RoofCeiling' ? 'roof' : surf.type === 'Floor' ? 'floor' : 'wall',
        boundary: surf.boundary,
        areaM2: snap9(Math.max(0, grossAreaM2 - openingAreaM2)),
        grossAreaM2: snap9(grossAreaM2),
        ...direction,
      });
      for (const opening of exteriorSolarSurface ? exportedOpenings : []) {
        if (opening.win.subtype === 'door' || opening.win.isVoid) continue;
        surfaceManifest.push({
          epName: opening.name,
          sourceId: opening.win._pitchedSkylightParentId || opening.win.id,
          exportedId: opening.win.id,
          hostSourceId: surf.type === 'RoofCeiling' && surf._pitchedRoofParentId ? surf._pitchedRoofParentId : surf.id,
          hostEpName: name,
          zoneId: surf.zoneId,
          kind: 'window',
          assembly: 'window',
          boundary: surf.boundary,
          areaM2: snap9(opening.areaM2),
          ...direction,
        });
      }
    }
  }

  const validShadingPolygons=[];
  shadingPolygons.forEach((shade,index)=>{
    if(!Array.isArray(shade?.vertices)||shade.vertices.length<3){
      warnings.push({type:'invalid-shading-polygon',shadeId:shade?.name??index});
      return;
    }
    const vertices=cleanEnergyVertices(shade.vertices.map(([x,y,z])=>{
      const xy=rotate2D({x,y},trueNorth,trueAnchor.x,trueAnchor.y);
      return vertex(xy.x,xy.y,z);
    }));
    if(vertices.length<3){
      warnings.push({type:'invalid-shading-polygon',shadeId:shade?.name??index});
      return;
    }
    const planarVertices = vertices.map(point => ({
      x:point.vertex_x_coordinate, y:point.vertex_y_coordinate, z:point.vertex_z_coordinate,
    }));
    const horizontal = Math.max(...planarVertices.map(point => point.z)) - Math.min(...planarVertices.map(point => point.z)) <= 1e-7;
    if (horizontal && !horizontalPolygonIsConvex(planarVertices)) {
      const z = planarVertices[0].z;
      const parts = triangulateHorizontalPolygon(planarVertices).map(part =>
        part.map(point => vertex(point.x, point.y, z)));
      if (parts.length >= 2) {
        parts.forEach((part, partIndex) => validShadingPolygons.push({
          ...shade,
          name:`${shade.name || `Shade_${index + 1}`}_convex_${partIndex + 1}`,
          _energyVertices:part,
        }));
        warnings.push({type:'non-convex-shading-polygon-triangulated', shadeId:shade?.name ?? index, fragments:parts.length});
        return;
      }
    }
    validShadingPolygons.push({...shade,_energyVertices:vertices});
  });
  if (validShadingPolygons.length) epjson['Shading:Building:Detailed'] = {};
  validShadingPolygons.forEach((sh, i) => {
    const sourceName=sanitize(sh.name||`Shade_${String(i + 1).padStart(3,'0')}`);
    const name=`${sourceName}_${String(i + 1).padStart(3,'0')}`;
    const obj = {
      vertices:sh._energyVertices,
    };
    if (sh.transmission !== undefined) {
      const sched = `${name}_Transmittance`;
      epjson['Schedule:Compact'][sched] = alwaysSchedule(sh.transmission);
      obj.transmittance_schedule_name = sched;
    }
    epjson['Shading:Building:Detailed'][name] = obj;
  });

  const outputNames = [
    'Zone Ideal Loads Supply Air Total Heating Energy',
    'Zone Ideal Loads Supply Air Total Cooling Energy',
    'Zone Air System Sensible Heating Energy',
    'Zone Air System Sensible Cooling Energy',
    'Zone Lights Electricity Energy',
    'Zone Electric Equipment Electricity Energy',
    // Dashboard-only reporting streams. These Output:Variable requests do
    // not alter the EnergyPlus model or heat-balance physics; they expose
    // actual monthly gains/losses already calculated by the simulation.
    'Zone Ventilation Fan Electricity Energy',
    'Zone Windows Total Heat Gain Energy',
    'Zone Windows Total Heat Loss Energy',
    'Zone People Total Heating Energy',
    'Zone Lights Total Heating Energy',
    'Zone Electric Equipment Total Heating Energy',
    'Zone Opaque Surface Inside Faces Conduction Heat Gain Energy',
    'Zone Opaque Surface Inside Faces Conduction Heat Loss Energy',
    'Zone Infiltration Total Heat Gain Energy',
    'Zone Infiltration Total Heat Loss Energy',
    'Zone Ventilation Total Heat Gain Energy',
    'Zone Ventilation Total Heat Loss Energy',
    // Element-level monthly heat balance. Signed opaque conduction is
    // classified through surfaceManifest; window conduction is the net
    // window transfer less its separately reported transmitted solar.
    'Surface Inside Face Conduction Heat Transfer Energy',
    'Surface Window Net Heat Transfer Rate',
    'Zone Mean Air Temperature',
    'Zone Operative Temperature',
    // NOT "Zone Windows..." — E+ 26.1 reports this on the SOLAR ENCLOSURE
    // (SolarShading.cc SetupOutputVariable), a distinct domain from HVAC
    // zones; "Zone Windows Total Transmitted Solar Radiation Energy" is not
    // a real variable name and silently produces zero rows (Gate P
    // discovery, 2026-07-07 — see CLAUDE.md Stage 5-D).
    'Enclosure Windows Total Transmitted Solar Radiation Energy',
    'Surface Outside Face Incident Solar Radiation Rate per Area',
    'Surface Window Transmitted Solar Radiation Energy',
    'Site Outdoor Air Drybulb Temperature',
    ...(comfortModel ? [
      'Zone Thermal Comfort Fanger Model PMV',
      'Zone People Occupant Count',
    ] : []),
  ];
  outputNames.forEach((variableName, i) => {
    epjson['Output:Variable'][`OutputVar_${String(i + 1).padStart(2, '0')}`] = {
      key_value: '*',
      variable_name: variableName,
      reporting_frequency: 'Hourly',
    };
  });

  for (const [type, entries] of Object.entries(epjson)) {
    if (entries && typeof entries === 'object' && !Array.isArray(entries) && Object.keys(entries).length === 0) {
      delete epjson[type];
    }
  }

  return {
    epjson: sortedObject(epjson), warnings, defaulted, surfaceManifest,
    conditionedFloorAreaByZone:sortedObject(conditionedFloorAreaByZone),
  };
}

export { areaOfVertices, sanitize, surfaceDirection };
