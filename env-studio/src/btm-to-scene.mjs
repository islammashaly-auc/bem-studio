/**
 * BTM → scene.mjs adapter.
 *
 * Converts one BTM zone (from compileBTM output) to the scene.mjs input
 * object, applying a trueNorth rotation so geographic north = +Y in the
 * Radiance coordinate system.
 *
 * Y-axis convention:
 *   BTM large-Y = geographic north = Radiance +Y.  No Y-flip needed.
 *   The 2D canvas has Y increasing downward, so geographic north is at the
 *   BOTTOM of the canvas (large Y).  Users who draw with "north at top of
 *   screen" (conventional floor-plan orientation) must set trueNorth=180 so
 *   the adapter rotates the building into geographic alignment.
 *   The Three.js viewer keeps its display mapping separate and uses drawing
 *   Y directly for visual 2D/3D plan registration; this adapter only defines
 *   the simulation-space conversion.
 *
 * Zone closure guarantee:
 *   compileBTM() always emits a RoofCeiling surface for every zone.
 *   scene.mjs independently generates floor + ceiling + walls from
 *   footprint + height — neither depends on the other.  The ceiling cannot
 *   be missing as long as zone.height > 0.
 *
 * Wall normals:
 *   BTM wall normals are OUTWARD (pointing away from zone centroid).  This
 *   adapter passes the footprint (CCW in Y-up standard math, as the BTM
 *   always produces) to scene.mjs, which generates its own polygon winding
 *   for inward-facing wall surfaces.  BTM surface normals are not used here.
 *
 * @param {object} zone         compileBTM zone object
 * @param {Array}  allSurfaces  compileBTM surfaces[] (all zones)
 * @param {number} trueNorth    site.trueNorth in degrees (clockwise from geographic north)
 * @param {object} [opts]
 * @param {object} [opts.materials]   { ceiling, walls, floor } reflectances
 * @param {number} [opts.glazingVT]   measured transmittance (default 0.75)
 * @param {number} [opts.wallThickness] Radiance-only window reveal depth (default 0 = validated zero-thickness model; opt-in)
 * @param {number} [opts.groundRho]   exterior ground reflectance (default 0.20)
 * @returns {object}  scene.mjs input: { footprint, height, windows, materials, glazingVT, groundRho }
 */

import { buildPitchedRoofGeometry } from './pitched-roof-geometry.mjs?v=straight-skeleton-hip-20260731';

const DEG = Math.PI / 180;

/** Rotate point by −angleDeg around centroid (converts drawing coords → geographic coords). */
function rotate2D(pt, angleDeg, cx, cy) {
  const a   = -angleDeg * DEG;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx  = pt.x - cx, dy = pt.y - cy;
  return { x: dx * cos - dy * sin + cx, y: dx * sin + dy * cos + cy };
}

function near(a, b, eps = 1e-3) {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

function sub2(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function dot2(a, b) { return a.x * b.x + a.y * b.y; }
function len2(v)    { return Math.sqrt(v.x * v.x + v.y * v.y); }
const snap9 = v => Math.round(v * 1e9) / 1e9;

export function btmToScene(zone, allSurfaces, trueNorth = 0, opts = {}) {
  const {
    materials = { ceiling: 0.80, walls: 0.50, floor: 0.20 },
    glazingVT = 0.75,
    wallThickness = 0,
    groundRho = 0.20,
    shades = [],
    anchor = null,
  } = opts;

  if (!(zone.height > 0))
    throw new Error(`btmToScene: zone "${zone.id}" height=${zone.height} (must be >0)`);

  // Rotation anchor: the zone's own centroid (the validated single-zone
  // default), or a caller-supplied shared anchor (btmToSceneFloor rotates
  // every zone of a floor about ONE point so shared geometry stays attached).
  const cx = anchor ? anchor.x : zone.centroid.x;
  const cy = anchor ? anchor.y : zone.centroid.y;

  // Apply −trueNorth rotation: converts drawing-space coords → geographic coords
  // (geographic north = +Y, consistent with Radiance and with the BTM's large-Y=north convention).
  // Snap to a 1 nm grid after rotation: the −trueNorth rotation (and the BTM
  // compile chain) leave ~1e-16 float dust on otherwise-exact coordinates
  // (0 → 4.44e-16, 0.15 → 0.1499999999999999). scene.mjs prints tiny nonzero
  // values in exponential notation, so the dust changes the scene FILE BYTES
  // → different octree → different fixed-seed MC sample sequence → borderline
  // sensors can flip. 1e-9 m is physically meaningless and far below the
  // 6-significant-digit rad output resolution for real coordinates.
  const rotFP = zone.footprint.map(p => {
    const r = rotate2D(p, trueNorth, cx, cy);
    return { x: snap9(r.x), y: snap9(r.y) };
  });
  const n     = rotFP.length;

  // Canonical start vertex: rotate the cycle so the footprint always begins
  // at the lexicographically smallest vertex (min y, then min x). Vertex
  // traversal order sets the emitted polygon order and hence the octree
  // layout; two drawings of the SAME room must produce byte-identical scene
  // files so the fixed-seed Monte Carlo estimate is reproducible — a
  // re-ordered octree yields a different (equally valid) sample sequence,
  // which can flip borderline sensors across the sDA/ASE thresholds.
  // No-op for footprints already starting at their canonical vertex.
  let _start = 0;
  for (let i = 1; i < n; i++) {
    const a = rotFP[i], b = rotFP[_start];
    if (a.y < b.y - 1e-9 || (Math.abs(a.y - b.y) <= 1e-9 && a.x < b.x - 1e-9)) _start = i;
  }
  if (_start > 0) rotFP.push(...rotFP.splice(0, _start));

  const windows = [];
  const skylights = [];
  const pitchedRoofTriangles = [];
  const roofClosures = [];
  const zoneZBase = +(zone.zBase ?? 0);

  for (const surf of allSurfaces) {
    if (surf.zoneId   !== zone.id)    continue;
    if (surf.type     !== 'Wall')     continue;
    // Pitched-roof closures are above the zone's ordinary wall-top plane.
    // The legacy Radiance scene schema only accepts footprint-wall windows;
    // treating a closure window as one would cut a duplicate opening near
    // the floor. Keep it out of that flat-wall compatibility path.
    if (surf._roofClosure)             continue;
    if (surf.boundary !== 'Outdoors') continue;
    if (!surf.windows || !surf.windows.length) continue;

    // Rotate wall endpoints into geographic coordinates
    const rp1 = rotate2D(surf.p1, trueNorth, cx, cy);
    const rp2 = rotate2D(surf.p2, trueNorth, cx, cy);

    // Find which rotated footprint edge corresponds to this wall
    const wall_index = rotFP.findIndex((fp, i) =>
      near(fp, rp1) && near(rotFP[(i + 1) % n], rp2)
    );
    if (wall_index < 0) continue; // wall not in footprint (interior or detached component)

    const wallStart = rotFP[wall_index];
    const wallVec   = sub2(rotFP[(wall_index + 1) % n], wallStart);
    const wallLen   = len2(wallVec);
    const u         = { x: wallVec.x / wallLen, y: wallVec.y / wallLen };

    for (const win of surf.windows) {
      if (win.subtype === 'door') continue;

      // Rotate window 2D endpoints into geographic coordinates
      const rw1    = rotate2D({ x: win.x1, y: win.y1 }, trueNorth, cx, cy);
      const rw2    = rotate2D({ x: win.x2, y: win.y2 }, trueNorth, cx, cy);

      // Project onto wall unit vector to get offset from wall start
      const t1     = dot2(sub2(rw1, wallStart), u);
      const t2     = dot2(sub2(rw2, wallStart), u);

      windows.push({
        wall_index,
        sill:   snap9(win.z0),
        head:   snap9(win.z0 + win.height),
        width:  snap9(win.width),
        offset: snap9(Math.min(t1, t2)),
        wallThickness: win.wallThickness ?? wallThickness,
        vt: win.vt,
        isVoid: win.isVoid === true || win.subtype === 'hole',
      });
    }
  }

  // A pitched roof changes the daylight enclosure itself: its facets replace
  // the legacy flat ceiling, and the wall-shaped infill above the ordinary
  // zone height becomes a real Radiance host.  All Z coordinates stay local
  // to the zone here; generateBuildingScene adds `_zBase` when appropriate.
  const pitchedRoofs = allSurfaces.filter(surf =>
    surf.zoneId === zone.id && surf.type === 'RoofCeiling'
    && surf.boundary === 'Outdoors' && surf.roof?.type
    && surf.roof.type !== 'flat' && +(surf.roof.ridgeHeight || 0) > 0);

  const rotateRoofPoint = point => {
    const p = rotate2D(point, trueNorth, cx, cy);
    return [snap9(p.x), snap9(p.y), snap9((point.z ?? zoneZBase) - zoneZBase)];
  };

  for (const roof of pitchedRoofs) {
    const built = buildPitchedRoofGeometry(roof);
    for (const triangle of built.roofTriangles || []) {
      pitchedRoofTriangles.push(triangle.map(rotateRoofPoint));
    }

    // env_studio materializes these as BTM walls so 3D, EnergyPlus, and
    // Radiance all consume the same clipped opening fragments.  Keep a solid
    // geometry fallback for older/imported BTM documents that have not yet
    // materialized them.
    const materialized = allSurfaces.filter(surf =>
      surf.zoneId === zone.id && surf.type === 'Wall' && surf._roofClosure
      && (!surf._pitchedRoofParentId || surf._pitchedRoofParentId === roof.id));
    const closures = materialized.length ? materialized : (built.closureSurfaces || []);

    for (const closure of closures) {
      const p1src = closure.p1;
      const p2src = closure.p2;
      if (!p1src || !p2src) continue;
      const p1 = rotate2D(p1src, trueNorth, cx, cy);
      const p2 = rotate2D(p2src, trueNorth, cx, cy);
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const length = Math.hypot(dx, dy);
      if (length <= 1e-9) continue;
      const u = { x: dx / length, y: dy / length };
      const closureWindows = [];

      for (const win of closure.windows || []) {
        if (win.subtype === 'door') continue;
        const rw1 = rotate2D({ x: win.x1, y: win.y1 }, trueNorth, cx, cy);
        const rw2 = rotate2D({ x: win.x2, y: win.y2 }, trueNorth, cx, cy);
        const t1 = (rw1.x - p1.x) * u.x + (rw1.y - p1.y) * u.y;
        const t2 = (rw2.x - p1.x) * u.x + (rw2.y - p1.y) * u.y;
        const zBase = +(closure.zBase ?? roof.z ?? zoneZBase);
        closureWindows.push({
          id: win.id,
          offset: snap9(Math.min(t1, t2)),
          width: snap9(Math.abs(t2 - t1)),
          sill: snap9(zBase + +(win.z0 ?? 0) - zoneZBase),
          head: snap9(zBase + +(win.z0 ?? 0) + +(win.height ?? 0) - zoneZBase),
          wallThickness: win.wallThickness ?? wallThickness,
          vt: win.vt,
          isVoid: win.isVoid === true || win.subtype === 'hole',
        });
      }

      roofClosures.push({
        id: closure.id,
        p1: [snap9(p1.x), snap9(p1.y)],
        p2: [snap9(p2.x), snap9(p2.y)],
        zBase: snap9(+(closure.zBase ?? roof.z ?? zoneZBase) - zoneZBase),
        bottomZ1: snap9(+(closure.bottomZ1 ?? closure.zBase ?? roof.z ?? zoneZBase) - zoneZBase),
        bottomZ2: snap9(+(closure.bottomZ2 ?? closure.zBase ?? roof.z ?? zoneZBase) - zoneZBase),
        topZ1: snap9(+(closure.topZ1 ?? closure.zBase ?? roof.z ?? zoneZBase) - zoneZBase),
        topZ2: snap9(+(closure.topZ2 ?? closure.zBase ?? roof.z ?? zoneZBase) - zoneZBase),
        windows: closureWindows,
      });
    }
  }

  for (const surf of allSurfaces) {
    if (surf.zoneId !== zone.id) continue;
    if (surf.type !== 'RoofCeiling') continue;
    if (surf.boundary !== 'Outdoors') continue;
    if (!surf.skylights || !surf.skylights.length) continue;
    for (const sk of surf.skylights) {
      skylights.push({
        id: sk.id,
        type: sk.type || 'polygon',
        vertices: (sk.pts || []).map(p => {
          const rp = rotate2D(p, trueNorth, cx, cy);
          return [snap9(rp.x), snap9(rp.y)];
        }),
        glazingVT: sk.glazingVT,
        isVoid: !!sk.isVoid,
      });
    }
  }

  // Floor/slab openings (roof/slab opening tool, target 'floor'|'both'):
  // gathered the same way as ceiling skylights, but from the zone's own
  // Floor surface. Skipped when the floor is part of a cross-level paired
  // slab (boundary === 'Surface') — btmToSceneBuilding's slab-void
  // collection handles that case once, from either side of the pair,
  // to avoid double-cutting the same physical slab.
  const floorOpenings = [];
  for (const surf of allSurfaces) {
    if (surf.zoneId !== zone.id) continue;
    if (surf.type !== 'Floor') continue;
    if (surf.boundary === 'Surface') continue;
    if (!surf.skylights || !surf.skylights.length) continue;
    for (const sk of surf.skylights) {
      floorOpenings.push({
        id: sk.id,
        type: sk.type || 'polygon',
        vertices: (sk.pts || []).map(p => {
          const rp = rotate2D(p, trueNorth, cx, cy);
          return [snap9(rp.x), snap9(rp.y)];
        }),
        glazingVT: sk.glazingVT,
        isVoid: !!sk.isVoid,
      });
    }
  }

  const rotShades = shades.map(sh => ({
    ...sh,
    vertices: (sh.vertices || []).map(([x, y, z]) => {
      const p = rotate2D({ x, y }, trueNorth, cx, cy);
      return [snap9(p.x), snap9(p.y), z];
    }),
  }));

  return {
    footprint:    rotFP.map(p => [p.x, p.y]),
    btmFootprint: zone.footprint.map(p => [p.x, p.y]),
    centroid:     { x: cx, y: cy },
    trueNorth,
    height:       zone.height,
    windows,
    pitchedRoofTriangles,
    roofClosures,
    skylights,
    floorOpenings,
    materials,
    glazingVT,
    groundRho,
    shades: rotShades,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5-C.1: BTM → whole-floor coupled scene (all zones of one level in ONE
// Radiance scene). Consumed by scene.mjs generateFloorScene().
//
// Reuses btmToScene() per zone with a SHARED rotation anchor (per-zone
// centroids would tear shared geometry apart under trueNorth rotation).
// The anchor is the area-weighted mean of zone centroids, which for a
// single-zone floor IS that zone's centroid — so a one-zone floor reduces
// exactly (byte-identically) to the validated single-zone adapter output.
//
// Interior partitions: BTM Wall surfaces tagged boundary='Surface' come in
// PAIRS (one per zone side, linked by adjacentSurfaceId). The pairing data
// stays in the BTM (engine-agnostic — the future EnergyPlus adapter needs
// both partners); here it is merely VIEWED: each partition is emitted once,
// deduped by snapped geometry, and the owning zones skip that footprint edge
// (two coplanar wall polygons would create the same float-crack class as the
// ground z=0 lesson). Windows on interior walls are ignored for now
// (partitions are opaque — Stage 5-C.2 adds interior glazing).
//
// Determinism: zone emission order and partition order are canonical
// (sorted by snapped rotated geometry), so neither the BTM zone array order
// nor the surface array order can change the scene file bytes.
// ─────────────────────────────────────────────────────────────────────────────

export function btmToSceneFloor(btm, levelIdx = 0, trueNorth = 0, opts = {}) {
  const { levelElevation = 0 } = opts;
  const zones = (btm.zones || []).filter(z => (z.levelIdx ?? 0) === levelIdx && z.height > 0);
  if (!zones.length)
    throw new Error(`btmToSceneFloor: no zones with height>0 on level ${levelIdx}`);

  // Shared anchor: area-weighted mean of zone centroids (shoelace area).
  let aSum = 0, axSum = 0, aySum = 0;
  for (const z of zones) {
    const a = Math.abs(shoelaceArea(z.footprint)) || 1e-9;
    aSum += a; axSum += a * z.centroid.x; aySum += a * z.centroid.y;
  }
  const anchor = { x: axSum / aSum, y: aySum / aSum };

  const zoneInputs = zones.map(z => ({
    zoneId: z.id,
    ...btmToScene(z, btm.surfaces, trueNorth, { ...opts, anchor }),
  }));

  // Interior partition edges: mark them skipped on each owning zone and
  // collect each partition once (geometric dedupe — the two paired surfaces
  // share the same wall segment).
  //
  // Interior glazing (5-C.2): windows on 'Surface' walls become glass panes
  // in the deduped partition. compileBTM attaches an opening to EVERY host
  // surface of the shared edge (both pair partners carry the same record),
  // so windows are merged across the pair and deduped by snapped geometry.
  // Doors stay opaque (LM-83 closed-door convention) — same skip as the
  // exterior path.
  const partMap = new Map();
  zones.forEach((zone, i) => {
    const skip = [];
    for (const surf of btm.surfaces || []) {
      if (surf.type !== 'Wall' || surf.boundary !== 'Surface') continue;
      if (surf.zoneId !== zone.id) continue;
      const q1 = snapPt(rotate2D(surf.p1, trueNorth, anchor.x, anchor.y));
      const q2 = snapPt(rotate2D(surf.p2, trueNorth, anchor.x, anchor.y));
      const idx = edgeIndexOf(zoneInputs[i].footprint, q1, q2);
      if (idx >= 0) skip.push(idx);

      const z0 = snap9((surf.zBase ?? 0) - levelElevation);
      const z1 = snap9(z0 + (surf.height ?? zone.height));
      const [a, b] = orderPts(q1, q2);
      const key = `${a.x},${a.y},${b.x},${b.y},${z0},${z1}`;
      let part = partMap.get(key);
      if (!part) {
        part = { p1: [a.x, a.y], p2: [b.x, b.y], z0, z1, windows: [], _winKeys: new Set() };
        partMap.set(key, part);
      }

      const vec = { x: part.p2[0] - part.p1[0], y: part.p2[1] - part.p1[1] };
      const L   = len2(vec);
      const u   = { x: vec.x / L, y: vec.y / L };
      const p1pt = { x: part.p1[0], y: part.p1[1] };
      for (const win of surf.windows || []) {
        if (win.subtype === 'door') continue;
        const rw1 = rotate2D({ x: win.x1, y: win.y1 }, trueNorth, anchor.x, anchor.y);
        const rw2 = rotate2D({ x: win.x2, y: win.y2 }, trueNorth, anchor.x, anchor.y);
        const t1  = dot2(sub2(rw1, p1pt), u);
        const t2  = dot2(sub2(rw2, p1pt), u);
        const entry = {
          sill:   snap9(win.z0),
          head:   snap9(win.z0 + win.height),
          width:  snap9(win.width),
          offset: snap9(Math.min(t1, t2)),
          vt:     win.vt,
          isVoid: win.isVoid === true || win.subtype === 'hole',
        };
        const wkey = `${entry.offset},${entry.sill},${entry.head},${entry.width},${entry.vt ?? ''},${entry.isVoid}`;
        if (part._winKeys.has(wkey)) continue;
        part._winKeys.add(wkey);
        part.windows.push(entry);
      }
    }
    if (skip.length) zoneInputs[i]._skipWallIndices = skip.sort((x, y) => x - y);
  });

  const partitions = [...partMap.values()].map(({ _winKeys, ...p }) => ({
    ...p,
    windows: p.windows.sort((a, b) => (a.offset - b.offset) || (a.sill - b.sill)),
  }));

  partitions.sort((u, v) =>
    (u.p1[1] - v.p1[1]) || (u.p1[0] - v.p1[0]) ||
    (u.p2[1] - v.p2[1]) || (u.p2[0] - v.p2[0]) || (u.z0 - v.z0));

  // Canonical zone order: by canonical start vertex of the rotated footprint
  // (btmToScene already rotates each cycle to start there), tie-broken by the
  // second vertex.
  const order = zoneInputs.map((_, i) => i).sort((a, b) => {
    const fa = zoneInputs[a].footprint, fb = zoneInputs[b].footprint;
    return (fa[0][1] - fb[0][1]) || (fa[0][0] - fb[0][0]) ||
           (fa[1][1] - fb[1][1]) || (fa[1][0] - fb[1][0]);
  });

  return {
    multiZone: true,
    anchor,
    trueNorth,
    zones: order.map(i => zoneInputs[i]),
    partitions,
  };
}

function shoelaceArea(footprint) {
  let s = 0;
  for (let i = 0; i < footprint.length; i++) {
    const p = footprint[i], q = footprint[(i + 1) % footprint.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

function snapPt(p) { return { x: snap9(p.x), y: snap9(p.y) }; }

function orderPts(a, b) {
  return (a.y < b.y || (a.y === b.y && a.x <= b.x)) ? [a, b] : [b, a];
}

/** Index of the footprint edge matching segment q1–q2 (either direction), or −1. */
function edgeIndexOf(footprint, q1, q2) {
  const n = footprint.length;
  for (let i = 0; i < n; i++) {
    const a = { x: footprint[i][0],           y: footprint[i][1] };
    const b = { x: footprint[(i + 1) % n][0], y: footprint[(i + 1) % n][1] };
    if ((near(a, q1) && near(b, q2)) || (near(a, q2) && near(b, q1))) return i;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 5-C.7: BTM → whole-BUILDING coupled scene (all zones of ALL levels in
// ONE Radiance scene, absolute Z). Consumed by scene.mjs generateBuildingScene().
//
// Same shared-rotation-anchor and interior-wall-partition-dedup mechanics as
// btmToSceneFloor, extended two ways:
//   1. ABSOLUTE Z — each zone's scene input carries `_zBase = zone.zBase`
//      (its level's elevation), consumed by scene.mjs's zBase support
//      (Stage 5-C.7 step 1). btmToScene() itself stays Z-agnostic; `_zBase`
//      is attached to its output afterward, purely additive.
//   2. SLABS — cross-level Floor/RoofCeiling pairs (boundary='Surface',
//      linked by adjacentSurfaceId — see pairFloorsAndCeilingsAcrossLevels
//      in the BTM compiler) are emitted ONCE as an opaque shared slab,
//      instead of once as the lower zone's ceiling AND once as the upper
//      zone's floor (the same float-crack class as interior wall
//      partitions and the ground z=0 lesson). A slab's void openings come
//      from the ceiling surface's `skylights` array — reusing the existing
//      skylight schema rather than inventing a new one: an "atrium void"
//      is exactly a skylight cutout with no glass pane (scene.mjs's
//      `isVoid` flag), so an upper zone's skylight over a slab opening
//      lets light reach the zone below.
//
// A single ground-floor zone with no partitions and no slabs reduces
// byte-identically to the validated single-zone scene (zBase=0 is a no-op
// in every Z expression scene.mjs adds it to).
// ─────────────────────────────────────────────────────────────────────────────

export function btmToSceneBuilding(btm, trueNorth = 0, opts = {}) {
  const zones = (btm.zones || []).filter(z => z.height > 0);
  if (!zones.length)
    throw new Error('btmToSceneBuilding: no zones with height>0');

  // Shared anchor across the WHOLE building — one trueNorth rotation for
  // every level (a building doesn't rotate floor to floor).
  let aSum = 0, axSum = 0, aySum = 0;
  for (const z of zones) {
    const a = Math.abs(shoelaceArea(z.footprint)) || 1e-9;
    aSum += a; axSum += a * z.centroid.x; aySum += a * z.centroid.y;
  }
  const anchor = { x: axSum / aSum, y: aySum / aSum };

  const zoneInputs = zones.map(z => ({
    zoneId: z.id,
    _zBase: z.zBase ?? 0,
    ...btmToScene(z, btm.surfaces, trueNorth, { ...opts, anchor }),
  }));
  const zoneIndexById = new Map(zones.map((z, i) => [z.id, i]));

  // Interior WALL partitions — level-scoped (a wall only ever pairs with
  // another wall on the SAME level); absolute Z throughout (no
  // levelElevation subtraction, unlike btmToSceneFloor's per-floor z=0
  // convention).
  const partMap = new Map();
  zones.forEach((zone, i) => {
    const skip = [];
    for (const surf of btm.surfaces || []) {
      if (surf.type !== 'Wall' || surf.boundary !== 'Surface') continue;
      if (surf.zoneId !== zone.id) continue;
      const q1 = snapPt(rotate2D(surf.p1, trueNorth, anchor.x, anchor.y));
      const q2 = snapPt(rotate2D(surf.p2, trueNorth, anchor.x, anchor.y));
      const idx = edgeIndexOf(zoneInputs[i].footprint, q1, q2);
      if (idx >= 0) skip.push(idx);

      const z0 = snap9(surf.zBase ?? 0);
      const z1 = snap9(z0 + (surf.height ?? zone.height));
      const [a, b] = orderPts(q1, q2);
      const key = `${a.x},${a.y},${b.x},${b.y},${z0},${z1}`;
      let part = partMap.get(key);
      if (!part) {
        part = { p1: [a.x, a.y], p2: [b.x, b.y], z0, z1, windows: [], _winKeys: new Set() };
        partMap.set(key, part);
      }

      const vec = { x: part.p2[0] - part.p1[0], y: part.p2[1] - part.p1[1] };
      const L   = len2(vec);
      const u   = { x: vec.x / L, y: vec.y / L };
      const p1pt = { x: part.p1[0], y: part.p1[1] };
      for (const win of surf.windows || []) {
        if (win.subtype === 'door') continue;
        const rw1 = rotate2D({ x: win.x1, y: win.y1 }, trueNorth, anchor.x, anchor.y);
        const rw2 = rotate2D({ x: win.x2, y: win.y2 }, trueNorth, anchor.x, anchor.y);
        const t1  = dot2(sub2(rw1, p1pt), u);
        const t2  = dot2(sub2(rw2, p1pt), u);
        const entry = {
          sill:   snap9(win.z0),
          head:   snap9(win.z0 + win.height),
          width:  snap9(win.width),
          offset: snap9(Math.min(t1, t2)),
          vt:     win.vt,
          isVoid: win.isVoid === true || win.subtype === 'hole',
        };
        const wkey = `${entry.offset},${entry.sill},${entry.head},${entry.width},${entry.vt ?? ''},${entry.isVoid}`;
        if (part._winKeys.has(wkey)) continue;
        part._winKeys.add(wkey);
        part.windows.push(entry);
      }
    }
    if (skip.length) zoneInputs[i]._skipWallIndices = skip.sort((x, y) => x - y);
  });

  const partitions = [...partMap.values()].map(({ _winKeys, ...p }) => ({
    ...p,
    windows: p.windows.sort((a, b) => (a.offset - b.offset) || (a.sill - b.sill)),
  }));
  partitions.sort((u, v) =>
    (u.p1[1] - v.p1[1]) || (u.p1[0] - v.p1[0]) ||
    (u.p2[1] - v.p2[1]) || (u.p2[0] - v.p2[0]) || (u.z0 - v.z0));

  // Cross-level SLABS — paired Floor/RoofCeiling surfaces (boundary='Surface',
  // linked by adjacentSurfaceId). Emitted ONCE per pair, deduped by the pair's
  // surface-id key (each pair is visited exactly twice — once from each
  // side's adjacentSurfaceId pointer — so a Set-based key dedupe suffices;
  // no snapped-geometry dedupe is needed the way wall partitions need it,
  // since a Floor/RoofCeiling pair is a single BTM adjacency link, not two
  // independently-drawn coincident edges).
  const slabMap = new Map();
  for (const surf of btm.surfaces || []) {
    if (surf.type !== 'RoofCeiling' || surf.boundary !== 'Surface') continue;
    const floor = (btm.surfaces || []).find(s => s.id === surf.adjacentSurfaceId);
    if (!floor || floor.type !== 'Floor') continue;
    const ci = zoneIndexById.get(surf.zoneId);
    const fi = zoneIndexById.get(floor.zoneId);
    if (ci === undefined || fi === undefined) continue; // one side not in our zone set

    const key = [surf.id, floor.id].sort().join('|');
    if (slabMap.has(key)) continue;

    const rotFP = surf.footprint.map(p => {
      const r = rotate2D(p, trueNorth, anchor.x, anchor.y);
      return [snap9(r.x), snap9(r.y)];
    });
    // A void drawn from either side of the pair — the lower zone's ceiling
    // (roof-target) or the upper zone's floor (floor-target) — cuts the SAME
    // physical slab, so both sources are unioned here. Dedup by id in the
    // (unlikely) case a 'both'-target opening's id shows up from both sides.
    const voidSrcs = [...(surf.skylights || []), ...(floor.skylights || [])];
    const seenVoidIds = new Set();
    const voids = voidSrcs.filter(sk => {
      if (seenVoidIds.has(sk.id)) return false;
      seenVoidIds.add(sk.id);
      return true;
    }).map(sk => ({
      id: sk.id,
      vertices: (sk.pts || []).map(p => {
        const rp = rotate2D(p, trueNorth, anchor.x, anchor.y);
        return [snap9(rp.x), snap9(rp.y)];
      }),
    }));

    slabMap.set(key, { footprint: rotFP, z: snap9(surf.z ?? 0), voids });
    zoneInputs[ci]._skipCeiling = true;
    zoneInputs[fi]._skipFloor   = true;
  }

  const slabs = [...slabMap.values()].sort((u, v) =>
    (u.z - v.z) || (u.footprint[0][1] - v.footprint[0][1]) || (u.footprint[0][0] - v.footprint[0][0]));

  // Canonical zone order: by canonical start vertex of the rotated
  // footprint, then by absolute Z (so stacked zones with an identical
  // footprint — the common case — still sort deterministically by level).
  const order = zoneInputs.map((_, i) => i).sort((a, b) => {
    const fa = zoneInputs[a].footprint, fb = zoneInputs[b].footprint;
    return (fa[0][1] - fb[0][1]) || (fa[0][0] - fb[0][0]) ||
           (fa[1][1] - fb[1][1]) || (fa[1][0] - fb[1][0]) ||
           (zoneInputs[a]._zBase - zoneInputs[b]._zBase);
  });

  return {
    multiZone: true,
    multiLevel: true,
    anchor,
    trueNorth,
    zones: order.map(i => zoneInputs[i]),
    partitions,
    slabs,
  };
}
