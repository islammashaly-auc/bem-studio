/**
 * Generate a Radiance RAD scene string from a polygon room description.
 *
 * Input schema:
 *   footprint:  [[x,y], ...]    ordered CCW floor polygon vertices (m)
 *   height:     H               floor-to-ceiling (m)
 *   windows:    [{ wall_index, sill, head, width, offset, wallThickness, vt }]
 *               vt: optional per-window visible transmittance override; when
 *               absent (the validated default) the global glazingVT is used.
 *   shades:     [{ name, reflectance, vertices:[[x,y,z], ...] }]
 *   materials:  { ceiling, walls, floor }  reflectances [0-1]
 *   glazingVT:  0.60            measured transmittance at normal incidence
 *   wallThickness: 0            Radiance-only window reveal depth (opt-in; 0 = validated
 *                               zero-thickness reference model — reveals shade oblique
 *                               rays and lower sDA/ASE, so callers enable it explicitly)
 *   groundRho:  0.20            exterior ground reflectance (always written, PR-4)
 *
 * Winding convention (Radiance outward-normal rule):
 *   floor   — CCW footprint at Z=0    → normal +Z (visible from inside looking down)
 *   ceiling — CW footprint at Z=H     → normal -Z (visible from inside looking up)
 *   walls   — [p0,Z=0]→[p0,Z=H]→[p1,Z=H]→[p1,Z=0] → inward normal (visible from inside)
 *
 * Sky is NOT written here — cbdm.mjs prepends GLOW_SKY_RAD or LIGHT_SKY_RAD at
 * octree build time.  Do not pass sky_mat definitions to this function.
 */

export function generateScene(input) {
  const {
    footprint,
    height: H,
    windows   = [],
    pitchedRoofTriangles = [],
    roofClosures = [],
    skylights = [],
    floorOpenings = [],
    shades    = [],
    exteriorOnly = false,
    materials = {},
    glazingVT = 0.60,
    wallThickness = 0,
    groundRho = 0.20,
  } = input;

  const ceilR   = materials.ceiling ?? 0.80;
  const wallR   = materials.walls   ?? 0.50;
  const floorR  = materials.floor   ?? 0.20;

  // Multi-zone emission controls (generateFloorScene): a name prefix, skipped
  // interior-wall edges, and suppression of the shared blocks (materials,
  // ground, shades) that the floor generator emits ONCE. All absent in the
  // validated single-zone path → output bytes unchanged.
  const PFX       = input._namePrefix ?? '';
  const skipWalls = input._skipWallIndices ?? [];

  // Stage 5-C.7 (whole-building): absolute Z placement for a zone stacked at
  // some level's elevation, and floor/ceiling suppression when that surface
  // is part of a cross-level shared slab (generateBuildingScene emits the
  // slab once). Both default to the single-floor convention (floor at
  // Z=0, ceiling at Z=H, both emitted) → output bytes unchanged when absent.
  const Z0 = input._zBase ?? 0;

  let rad = '';
  const roofClosureWindows = roofClosures.flatMap(closure => closure.windows ?? []);

  // ── Materials ──────────────────────────────────────────────────────────────
  if (!input._noMaterials) {
    rad += materialsRad({ ceilR, wallR, floorR, groundRho, glazingVT,
      customVTs: customVTList([...windows, ...roofClosureWindows], [...skylights, ...floorOpenings], glazingVT) });
  }
  const paneMat = vt =>
    (Number.isFinite(vt) && vt > 0 && Math.abs(vt - glazingVT) > 1e-9)
      ? glassMatName(vt) : 'glaz_mat';

  const n = footprint.length;

  if (exteriorOnly) {
    const cx = footprint.reduce((s, [x]) => s + x, 0) / n;
    const cy = footprint.reduce((s, [, y]) => s + y, 0) / n;
    const R   = Math.max(50, maxFootprintSpan(footprint) + 20);
    const GZ  = -0.001;
    rad += polygon('ground_mat', 'ground_plane', [
      [cx - R, cy - R, GZ],
      [cx + R, cy - R, GZ],
      [cx + R, cy + R, GZ],
      [cx - R, cy + R, GZ],
    ]);

    rad += shadesRad(shades);

    return rad;
  }

  // ── Floor (CCW → normal +Z) ───────────────────────────────────────────────
  // Stage 5-C.7 follow-on: a floor/slab opening (roof-tool's "floor" or "both"
  // target) cuts the floor the SAME way ceiling skylights do — floor_mat is a
  // plastic material, symmetric on both faces (already relied on for
  // cross-level slabs, see generateBuildingScene), so reusing the ceiling
  // cell-tiling helper here needs no new winding logic.
  if (!input._skipFloor) {
    if (floorOpenings.length) {
      rad += ceilingWithSkylights('floor_mat', footprint, floorOpenings, Z0, PFX);
    } else {
      rad += polygon('floor_mat', PFX + 'floor', footprint.map(([x, y]) => [x, y, Z0]));
    }
  }

  // ── Ceiling (reversed CCW = CW → normal -Z) ───────────────────────────────
  if (!input._skipCeiling) {
    if (pitchedRoofTriangles.length) {
      pitchedRoofTriangles.forEach((triangle, i) => {
        if (!triangle || triangle.length < 3) return;
        // Shared roof geometry is outward/upward. Reverse it so the ceiling
        // material faces into the occupied volume, matching the flat path.
        rad += polygon('ceiling_mat', `${PFX}pitched_roof_${i}`,
          [...triangle].reverse().map(([x, y, z]) => [x, y, z + Z0]));
      });
    } else if (skylights.length) {
      rad += ceilingWithSkylights('ceiling_mat', footprint, skylights, H + Z0, PFX);
    } else {
      rad += polygon('ceiling_mat', PFX + 'ceiling',
        [...footprint].reverse().map(([x, y]) => [x, y, H + Z0]));
    }
  }

  // ── Walls ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < n; i++) {
    if (skipWalls.includes(i)) continue; // interior partition — emitted once by generateFloorScene
    const p0  = footprint[i];
    const p1  = footprint[(i + 1) % n];
    const ex  = p1[0] - p0[0], ey = p1[1] - p0[1];
    const len = Math.hypot(ex, ey);
    const ux  = ex / len, uy = ey / len;
    const ox  = uy, oy = -ux; // outward normal for CCW footprint edge
    const c = (t, z, d = 0) => [p0[0] + ux * t + ox * d, p0[1] + uy * t + oy * d, z + Z0];
    const wallWindows = windows
      .filter(w => w.wall_index === i)
      .map((w, idx) => ({
        ...w,
        _idx: idx,
        offset: Math.max(0, Math.min(len, w.offset ?? 0)),
        sill: Math.max(0, Math.min(H, w.sill ?? 0)),
        head: Math.max(0, Math.min(H, w.head ?? H)),
        width: Math.max(0, w.width ?? 0),
      }))
      .map(w => ({ ...w, end: Math.max(0, Math.min(len, w.offset + w.width)) }))
      .filter(w => w.end - w.offset > 1e-6 && w.head - w.sill > 1e-6);

    if (!wallWindows.length) {
      // Solid wall: [p0,0]→[p0,H]→[p1,H]→[p1,0] → inward normal
      rad += polygon('wall_mat', `${PFX}wall_${i}`, [
        [p0[0], p0[1], Z0],
        [p0[0], p0[1], H + Z0],
        [p1[0], p1[1], H + Z0],
        [p1[0], p1[1], Z0],
      ]);
    } else {
      const tBreaks = uniqueSorted([0, len, ...wallWindows.flatMap(w => [w.offset, w.end])]);
      const zBreaks = uniqueSorted([0, H, ...wallWindows.flatMap(w => [w.sill, w.head])]);

      for (let ti = 0; ti < tBreaks.length - 1; ti++) {
        const t0 = tBreaks[ti], t1 = tBreaks[ti + 1];
        if (t1 - t0 <= 1e-6) continue;
        for (let zi = 0; zi < zBreaks.length - 1; zi++) {
          const z0 = zBreaks[zi], z1 = zBreaks[zi + 1];
          if (z1 - z0 <= 1e-6) continue;
          const tm = (t0 + t1) / 2, zm = (z0 + z1) / 2;
          const isOpening = wallWindows.some(w =>
            tm > w.offset + 1e-9 && tm < w.end - 1e-9 &&
            zm > w.sill + 1e-9 && zm < w.head - 1e-9
          );
          if (isOpening) continue;
          rad += polygon('wall_mat', `${PFX}wall_${i}_cell_${ti}_${zi}`,
            [c(t0, z0), c(t0, z1), c(t1, z1), c(t1, z0)]);
        }
      }

      wallWindows.forEach((win, wi) => {
        const { sill, head, offset, end: we } = win;
        const wt = Math.max(0, win.wallThickness ?? wallThickness);
        const suffix = wallWindows.length > 1 ? `${i}_${wi}` : `${i}`;

        // Glazing sits on the inside face. A wall hole deliberately omits the
        // pane while retaining optional reveal surfaces through wall depth.
        if (!win.isVoid) {
          rad += polygon(paneMat(win.vt), `${PFX}window_${suffix}`,
            [c(offset, sill), c(offset, head), c(we, head), c(we, sill)]);
        }

        if (wt > 1e-6) {
          rad += polygon('wall_mat', `${PFX}window_${suffix}_reveal_left`,
            [c(offset, sill), c(offset, sill, wt), c(offset, head, wt), c(offset, head)]);
          rad += polygon('wall_mat', `${PFX}window_${suffix}_reveal_right`,
            [c(we, sill), c(we, head), c(we, head, wt), c(we, sill, wt)]);
          rad += polygon('wall_mat', `${PFX}window_${suffix}_reveal_top`,
            [c(offset, head), c(offset, head, wt), c(we, head, wt), c(we, head)]);
          rad += polygon('wall_mat', `${PFX}window_${suffix}_reveal_bottom`,
            [c(offset, sill), c(we, sill), c(we, sill, wt), c(offset, sill, wt)]);
        }
      });
    }
  }

  // Wall-shaped roof infill above the ordinary zone height. These panels
  // complete the pitched daylight enclosure and host glazing at its true
  // elevation, including fragments of windows that cross the wall/roof seam.
  roofClosures.forEach((closure, i) => {
    rad += roofClosureRad(closure, i, paneMat, Z0, wallThickness, PFX);
  });

  // ── Exterior ground plane (always present — PR-4) ─────────────────────────
  // Placed at z=-0.001 (1mm below the room floor at z=0) to avoid coplanar
  // z-fighting with the floor polygon and the wall bases, which all sit at z=0.
  // A coplanar exterior ground creates a floating-point crack at the wall/floor/
  // ground junction — verified to flip one borderline sensor (~1.8pp artifact).
  if (!input._noGround) {
    const cx = footprint.reduce((s, [x]) => s + x, 0) / n;
    const cy = footprint.reduce((s, [, y]) => s + y, 0) / n;
    const R   = 50;   // 100 m × 100 m
    const GZ  = -0.001;  // 1 mm below room floor to prevent coplanar intersection
    rad += polygon('ground_mat', 'ground_plane', [
      [cx - R, cy - R, GZ],
      [cx + R, cy - R, GZ],
      [cx + R, cy + R, GZ],
      [cx - R, cy + R, GZ],
    ]);
  }

  if (!input._noShades) rad += shadesRad(shades);

  skylights.forEach((sk, i) => {
    if (!sk.vertices || sk.vertices.length < 3) return;
    if (sk.isVoid) return; // Stage 5-C.7 atrium/slab void — a real hole, no glass
    rad += polygon(paneMat(sk.glazingVT), PFX + (sk.id || `skylight_${i}`),
      [...sk.vertices].reverse().map(([x, y]) => [x, y, H + Z0 + 0.002]));
  });

  // Floor-opening panes: dormant today (the roof/slab opening tool always
  // marks isVoid on both targets), kept symmetric with the ceiling loop above
  // in case a future glazed-floor feature reuses this same field.
  floorOpenings.forEach((sk, i) => {
    if (!sk.vertices || sk.vertices.length < 3) return;
    if (sk.isVoid) return;
    rad += polygon(paneMat(sk.glazingVT), PFX + (sk.id || `floor_opening_${i}`),
      [...sk.vertices].reverse().map(([x, y]) => [x, y, Z0 - 0.002]));
  });

  return rad;
}

/**
 * Stage 5-C.1: whole-floor coupled scene from btmToSceneFloor() output.
 *
 * A one-zone floor with no interior partitions delegates VERBATIM to
 * generateScene() — byte-identical to the validated single-zone path, so the
 * sacred references are structurally preserved. For N≥2 zones:
 *   - materials emitted ONCE (custom-VT union across all zones' openings)
 *   - each zone's floor/ceiling/exterior walls with a `z<i>_` name prefix,
 *     interior edges skipped (per _skipWallIndices from the adapter)
 *   - each interior partition emitted ONCE at wall_mat (opaque — 5-C.2 adds
 *     interior glazing)
 *   - ONE exterior ground plane centred on all zones (R grows with the floor
 *     span, min 50 m as in the single-zone model)
 *   - shades emitted once (identical array on every zone input)
 */
export function generateFloorScene(floor) {
  const zones = floor?.zones || [];
  if (!zones.length) throw new Error('generateFloorScene: no zones');
  const partitions = floor.partitions || [];

  if (zones.length === 1 && !partitions.length && !(zones[0]._skipWallIndices?.length))
    return generateScene(zones[0]);

  const z0 = zones[0];
  const materials = z0.materials ?? {};
  const glazingVT = z0.glazingVT ?? 0.60;
  const customVTs = uniqueSorted([
    ...zones.flatMap(z => customVTList(
      [...(z.windows ?? []), ...(z.roofClosures ?? []).flatMap(closure => closure.windows ?? [])],
      [...(z.skylights ?? []), ...(z.floorOpenings ?? [])], glazingVT)),
    ...customVTList(partitions.flatMap(p => p.windows ?? []), [], glazingVT),
  ]);
  const paneMat = vt =>
    (Number.isFinite(vt) && vt > 0 && Math.abs(vt - glazingVT) > 1e-9)
      ? glassMatName(vt) : 'glaz_mat';

  let rad = materialsRad({
    ceilR:  materials.ceiling ?? 0.80,
    wallR:  materials.walls   ?? 0.50,
    floorR: materials.floor   ?? 0.20,
    groundRho: z0.groundRho ?? 0.20,
    glazingVT,
    customVTs,
  });

  zones.forEach((z, zi) => {
    rad += generateScene({
      ...z,
      _namePrefix:  `z${zi}_`,
      _noMaterials: true,
      _noGround:    true,
      _noShades:    true,
    });
  });

  partitions.forEach((pt, i) => {
    rad += partitionRad(pt, i, paneMat);
  });

  // ── Exterior ground plane (PR-4) — one for the whole floor ────────────────
  const allV = zones.flatMap(z => z.footprint);
  const cx = allV.reduce((s, [x]) => s + x, 0) / allV.length;
  const cy = allV.reduce((s, [, y]) => s + y, 0) / allV.length;
  const R  = Math.max(50, maxFootprintSpan(allV) + 20);
  const GZ = -0.001;
  rad += polygon('ground_mat', 'ground_plane', [
    [cx - R, cy - R, GZ],
    [cx + R, cy - R, GZ],
    [cx + R, cy + R, GZ],
    [cx - R, cy + R, GZ],
  ]);

  rad += shadesRad(z0.shades ?? []);

  return rad;
}

/**
 * Stage 5-C.7: whole-BUILDING coupled scene from btmToSceneBuilding() output.
 *
 * Extends generateFloorScene() to multiple stacked levels:
 *   - each zone's floor/ceiling/exterior walls with a `z<i>_` name prefix,
 *     ABSOLUTE Z (via _zBase, honored generically by generateScene),
 *     skipping its own floor/ceiling where a cross-level slab replaces it
 *     (_skipFloor/_skipCeiling from the adapter) and skipping interior
 *     wall edges as in generateFloorScene (_skipWallIndices)
 *   - interior wall partitions emitted once (unchanged from generateFloorScene)
 *   - NEW: cross-level slabs emitted once each, at 'floor_mat' (matches
 *     what daylight actually sees looking down through a void from the
 *     zone above — "floor_mat is one material both sides" per the
 *     Stage 5-C.7 design note), with any void openings cut via the SAME
 *     cell-tiling helper skylights use (an atrium void = a skylight
 *     cutout with no glass pane)
 *   - ONE exterior ground plane at the BUILDING's lowest zone elevation
 *     minus 1mm (not always z=-0.001 — a building whose lowest level
 *     doesn't start at z=0 still needs the ground just below its actual
 *     floor, for the same anti-coplanar-crack reason as the single-floor case)
 *   - shades emitted once
 *
 * A single ground-floor (zBase=0) zone with no partitions/slabs/skips
 * reduces byte-identically to generateScene(), matching the validated
 * single-zone reference exactly.
 */
export function generateBuildingScene(building) {
  const zones = building?.zones || [];
  if (!zones.length) throw new Error('generateBuildingScene: no zones');
  const partitions = building.partitions || [];
  const slabs       = building.slabs || [];

  if (zones.length === 1 && !partitions.length && !slabs.length &&
      !(zones[0]._skipWallIndices?.length) && !zones[0]._skipFloor && !zones[0]._skipCeiling &&
      !(zones[0]._zBase))
    return generateScene(zones[0]);

  const z0 = zones[0];
  const materials = z0.materials ?? {};
  const glazingVT = z0.glazingVT ?? 0.60;
  const customVTs = uniqueSorted([
    ...zones.flatMap(z => customVTList(
      [...(z.windows ?? []), ...(z.roofClosures ?? []).flatMap(closure => closure.windows ?? [])],
      [...(z.skylights ?? []), ...(z.floorOpenings ?? [])], glazingVT)),
    ...customVTList(partitions.flatMap(p => p.windows ?? []), [], glazingVT),
  ]);
  const paneMat = vt =>
    (Number.isFinite(vt) && vt > 0 && Math.abs(vt - glazingVT) > 1e-9)
      ? glassMatName(vt) : 'glaz_mat';

  let rad = materialsRad({
    ceilR:  materials.ceiling ?? 0.80,
    wallR:  materials.walls   ?? 0.50,
    floorR: materials.floor   ?? 0.20,
    groundRho: z0.groundRho ?? 0.20,
    glazingVT,
    customVTs,
  });

  zones.forEach((z, zi) => {
    rad += generateScene({
      ...z,
      _namePrefix:  `z${zi}_`,
      _noMaterials: true,
      _noGround:    true,
      _noShades:    true,
    });
  });

  partitions.forEach((pt, i) => {
    rad += partitionRad(pt, i, paneMat);
  });

  slabs.forEach((slab, i) => {
    if (slab.voids?.length) {
      rad += ceilingWithSkylights('floor_mat', slab.footprint, slab.voids, slab.z, `slab${i}_`);
    } else {
      rad += polygon('floor_mat', `slab${i}`, slab.footprint.map(([x, y]) => [x, y, slab.z]));
    }
  });

  // ── Exterior ground plane (PR-4) — one for the whole building, at the
  //    lowest zone's floor elevation (not always 0 — see docstring) ────────
  const allV = zones.flatMap(z => z.footprint);
  const cx = allV.reduce((s, [x]) => s + x, 0) / allV.length;
  const cy = allV.reduce((s, [, y]) => s + y, 0) / allV.length;
  const R  = Math.max(50, maxFootprintSpan(allV) + 20);
  const minZBase = Math.min(...zones.map(z => z._zBase ?? 0));
  const GZ = minZBase - 0.001;
  rad += polygon('ground_mat', 'ground_plane', [
    [cx - R, cy - R, GZ],
    [cx + R, cy - R, GZ],
    [cx + R, cy + R, GZ],
    [cx - R, cy + R, GZ],
  ]);

  rad += shadesRad(z0.shades ?? []);

  return rad;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function plastic(name, rho) {
  return `void plastic ${name}\n0\n0\n5 ${f(rho)} ${f(rho)} ${f(rho)} 0 0\n\n`;
}

/** The shared material block — extracted VERBATIM from generateScene so the
 *  single-zone output bytes are unchanged and generateFloorScene emits the
 *  identical block exactly once. */
function materialsRad({ ceilR, wallR, floorR, groundRho, glazingVT, customVTs }) {
  const glassT = vtToTransmissivity(glazingVT);
  let rad = '';
  rad += plastic('ceiling_mat', ceilR);
  rad += plastic('wall_mat',    wallR);
  rad += plastic('floor_mat',   floorR);
  rad += plastic('ground_mat',  groundRho);
  rad += plastic('shade_mat',   0.45);
  rad += `void glass glaz_mat\n0\n0\n3 ${f(glassT)} ${f(glassT)} ${f(glassT)}\n\n`;
  for (const vt of customVTs) {
    const t = vtToTransmissivity(vt);
    rad += `void glass ${glassMatName(vt)}\n0\n0\n3 ${f(t)} ${f(t)} ${f(t)}\n\n`;
  }
  return rad;
}

/** Per-opening VT overrides: one extra glass material per distinct explicit
 *  vt value. Openings without vt (the validated default) keep glaz_mat, so
 *  scenes that never set vt produce bit-identical output to before. */
function customVTList(windows, skylights, glazingVT) {
  return uniqueSorted([
    ...windows.map(w => w.vt),
    ...skylights.map(sk => sk.glazingVT),
  ].filter(v => Number.isFinite(v) && v > 0 && Math.abs(v - glazingVT) > 1e-9));
}

/** Emit one triangular/trapezoidal pitched-roof closure and cut its windows
 *  from the opaque host. Coordinates are local to the zone; Z0 places the
 *  same schema either on a floor-local scene or in a whole-building scene. */
function roofClosureRad(closure, i, paneMat, Z0, defaultWallThickness, PFX) {
  const [x1, y1] = closure.p1 ?? [];
  const [x2, y2] = closure.p2 ?? [];
  if (![x1, y1, x2, y2].every(Number.isFinite)) return '';
  const ex = x2 - x1, ey = y2 - y1;
  const len = Math.hypot(ex, ey);
  if (len <= 1e-9) return '';
  const ux = ex / len, uy = ey / len;
  const ox = uy, oy = -ux;
  const fallbackBase = Number.isFinite(closure.zBase) ? closure.zBase : 0;
  const bottom0 = Number.isFinite(closure.bottomZ1) ? closure.bottomZ1 : fallbackBase;
  const bottom1 = Number.isFinite(closure.bottomZ2) ? closure.bottomZ2 : fallbackBase;
  const base = Math.min(bottom0, bottom1);
  const top0 = Math.max(bottom0, Number.isFinite(closure.topZ1) ? closure.topZ1 : bottom0);
  const top1 = Math.max(bottom1, Number.isFinite(closure.topZ2) ? closure.topZ2 : bottom1);
  if (Math.max(top0-bottom0, top1-bottom1) <= 1e-9) return '';
  const bottomAt = t => bottom0 + (bottom1 - bottom0) * (t / len);
  const topAt = t => top0 + (top1 - top0) * (t / len);
  const c = (t, z, d = 0) => [x1 + ux * t + ox * d, y1 + uy * t + oy * d, z + Z0];

  const wins = (closure.windows ?? [])
    .map(w => {
      const offset = Math.max(0, Math.min(len, w.offset ?? 0));
      const end = Math.max(0, Math.min(len, offset + Math.max(0, w.width ?? 0)));
      const hostBottom = Math.max(bottomAt(offset), bottomAt(end));
      const hostTop = Math.min(topAt(offset), topAt(end));
      return {
        ...w,
        offset,
        end,
        sill: Math.max(hostBottom, Math.min(hostTop, w.sill ?? hostBottom)),
        head: Math.max(hostBottom, Math.min(hostTop, w.head ?? hostTop)),
      };
    })
    .filter(w => w.end - w.offset > 1e-6 && w.head - w.sill > 1e-6);

  // Clip a t/z cell against both sloping profile edges. Mixed-height adjacent
  // roofs can leave a genuine exposed strip whose lower and upper boundaries
  // both slope; preserving both lines keeps the Radiance enclosure congruent
  // with the BTM, Three.js, solar, and EnergyPlus geometry.
  const clipHalfPlane = (vertices, signed) => {
    const out = [];
    for (let vi = 0; vi < vertices.length; vi++) {
      const a = vertices[vi];
      const b = vertices[(vi + 1) % vertices.length];
      const da = signed(a), db = signed(b);
      const aIn = da <= 1e-9, bIn = db <= 1e-9;
      const intersection = () => {
        const alpha = Math.abs(da - db) <= 1e-12 ? 0 : da / (da - db);
        return [a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha];
      };
      if (aIn && bIn) out.push(b);
      else if (aIn && !bIn) out.push(intersection());
      else if (!aIn && bIn) out.push(intersection(), b);
    }
    return out;
  };
  const compactProfile = vertices => {
    const out=vertices;
    const compact = out.filter((p, idx) => {
      const prev = out[(idx - 1 + out.length) % out.length];
      return Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-8;
    });
    if (compact.length < 3) return [];
    let area2 = 0;
    compact.forEach((p, idx) => {
      const q = compact[(idx + 1) % compact.length];
      area2 += p[0] * q[1] - q[0] * p[1];
    });
    return Math.abs(area2) > 1e-8 ? compact : [];
  };
  const clipToProfile = vertices => compactProfile(clipHalfPlane(
    clipHalfPlane(vertices, ([t,z])=>z-topAt(t)),
    ([t,z])=>bottomAt(t)-z));

  let rad = '';
  const tBreaks = uniqueSorted([0, len, ...wins.flatMap(w => [w.offset, w.end])]);
  const zBreaks = uniqueSorted([bottom0,bottom1,top0,top1,...wins.flatMap(w => [w.sill, w.head])]);
  for (let ti = 0; ti < tBreaks.length - 1; ti++) {
    const ta = tBreaks[ti], tb = tBreaks[ti + 1];
    if (tb - ta <= 1e-6) continue;
    for (let zi = 0; zi < zBreaks.length - 1; zi++) {
      const za = zBreaks[zi], zb = zBreaks[zi + 1];
      if (zb - za <= 1e-6) continue;
      const tm = (ta + tb) / 2, zm = (za + zb) / 2;
      const isOpening = wins.some(w =>
        tm > w.offset + 1e-9 && tm < w.end - 1e-9
        && zm > w.sill + 1e-9 && zm < w.head - 1e-9);
      if (isOpening) continue;
      const cell = clipToProfile([[ta, za], [ta, zb], [tb, zb], [tb, za]]);
      if (cell.length >= 3) {
        rad += polygon('wall_mat', `${PFX}roof_closure_${i}_cell_${ti}_${zi}`,
          cell.map(([t, z]) => c(t, z)));
      }
    }
  }

  wins.forEach((w, wi) => {
    const suffix = `${PFX}roof_closure_${i}_window_${wi}`;
    if (!w.isVoid) {
      rad += polygon(paneMat(w.vt), suffix,
        [c(w.offset, w.sill), c(w.offset, w.head), c(w.end, w.head), c(w.end, w.sill)]);
    }

    const wt = Math.max(0, w.wallThickness ?? defaultWallThickness);
    if (wt > 1e-6) {
      rad += polygon('wall_mat', `${suffix}_reveal_left`,
        [c(w.offset, w.sill), c(w.offset, w.sill, wt), c(w.offset, w.head, wt), c(w.offset, w.head)]);
      rad += polygon('wall_mat', `${suffix}_reveal_right`,
        [c(w.end, w.sill), c(w.end, w.head), c(w.end, w.head, wt), c(w.end, w.sill, wt)]);
      rad += polygon('wall_mat', `${suffix}_reveal_top`,
        [c(w.offset, w.head), c(w.offset, w.head, wt), c(w.end, w.head, wt), c(w.end, w.head)]);
      rad += polygon('wall_mat', `${suffix}_reveal_bottom`,
        [c(w.offset, w.sill), c(w.end, w.sill), c(w.end, w.sill, wt), c(w.offset, w.sill, wt)]);
    }
  });

  return rad;
}

/** Interior partition emission (5-C.2): glazed openings tile their cut-outs
 *  with a pane; wall holes leave the corresponding area genuinely empty.
 *  Interior panes and voids are zero-thickness. */
function partitionRad(pt, i, paneMat) {
  const [x1, y1] = pt.p1, [x2, y2] = pt.p2;
  const ex  = x2 - x1, ey = y2 - y1;
  const len = Math.hypot(ex, ey);
  const ux  = ex / len, uy = ey / len;
  const c   = (t, z) => [x1 + ux * t, y1 + uy * t, z];

  const wins = (pt.windows ?? [])
    .map(w => ({
      offset: Math.max(0, Math.min(len, w.offset ?? 0)),
      sill:   Math.max(pt.z0, Math.min(pt.z1, w.sill ?? pt.z0)),
      head:   Math.max(pt.z0, Math.min(pt.z1, w.head ?? pt.z1)),
      width:  Math.max(0, w.width ?? 0),
      vt:     w.vt,
      isVoid: w.isVoid === true,
    }))
    .map(w => ({ ...w, end: Math.max(0, Math.min(len, w.offset + w.width)) }))
    .filter(w => w.end - w.offset > 1e-6 && w.head - w.sill > 1e-6);

  if (!wins.length) {
    return polygon('wall_mat', `partition_${i}`, [
      [x1, y1, pt.z0],
      [x1, y1, pt.z1],
      [x2, y2, pt.z1],
      [x2, y2, pt.z0],
    ]);
  }

  let rad = '';
  const tBreaks = uniqueSorted([0, len, ...wins.flatMap(w => [w.offset, w.end])]);
  const zBreaks = uniqueSorted([pt.z0, pt.z1, ...wins.flatMap(w => [w.sill, w.head])]);

  for (let ti = 0; ti < tBreaks.length - 1; ti++) {
    const t0 = tBreaks[ti], t1 = tBreaks[ti + 1];
    if (t1 - t0 <= 1e-6) continue;
    for (let zi = 0; zi < zBreaks.length - 1; zi++) {
      const zz0 = zBreaks[zi], zz1 = zBreaks[zi + 1];
      if (zz1 - zz0 <= 1e-6) continue;
      const tm = (t0 + t1) / 2, zm = (zz0 + zz1) / 2;
      const isOpening = wins.some(w =>
        tm > w.offset + 1e-9 && tm < w.end - 1e-9 &&
        zm > w.sill + 1e-9 && zm < w.head - 1e-9
      );
      if (isOpening) continue;
      rad += polygon('wall_mat', `partition_${i}_cell_${ti}_${zi}`,
        [c(t0, zz0), c(t0, zz1), c(t1, zz1), c(t1, zz0)]);
    }
  }

  wins.forEach((w, wi) => {
    if (!w.isVoid) {
      rad += polygon(paneMat(w.vt), `partition_${i}_win_${wi}`,
        [c(w.offset, w.sill), c(w.offset, w.head), c(w.end, w.head), c(w.end, w.sill)]);
    }
  });

  return rad;
}

/** Shade emission — extracted VERBATIM (was duplicated in the exteriorOnly
 *  and interior branches of generateScene). Optional partial transmission
 *  (tree canopies etc.): Radiance `trans` material — light passes through
 *  the fraction `transmission`, the rest reflects/absorbs like plastic.
 *  Absent (the validated default for all opaque shading devices) → plastic,
 *  bit-identical to before. */
function shadesRad(shades) {
  let rad = '';
  shades.forEach((sh, i) => {
    if (!sh.vertices || sh.vertices.length < 3) return;
    const mat = `shade_mat_${i}`;
    if (Number.isFinite(sh.transmission) && sh.transmission > 0) {
      const r = sh.reflectance ?? 0.30;
      const t = Math.min(0.95, sh.transmission);
      rad += `void trans ${mat}\n0\n0\n7 ${f(r)} ${f(r)} ${f(r)} 0 0 ${f(t)} 0\n\n`;
    } else {
      rad += plastic(mat, sh.reflectance ?? 0.45);
    }
    rad += polygon(mat, sh.name || `shade_${i}`, sh.vertices);
  });
  return rad;
}

function polygon(modifier, name, verts) {
  const coords = verts.map(([x, y, z]) => `  ${f(x)} ${f(y)} ${f(z)}`).join('\n');
  return `${modifier} polygon ${name}\n0\n0\n${verts.length * 3}\n${coords}\n\n`;
}

function glassMatName(vt) {
  return `glaz_mat_vt${String(+vt.toFixed(4)).replace('.', 'p')}`;
}

function uniqueSorted(values) {
  return [...new Set(values.map(v => +v.toFixed(9)))].sort((a, b) => a - b);
}

function pointInPoly2(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > p[1]) !== (yj > p[1])) &&
        (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

function ceilingWithSkylights(mat, footprint, skylights, H, PFX = '') {
  const xs = footprint.map(p => p[0]);
  const ys = footprint.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const holePolys = skylights.map(sk => sk.vertices || []).filter(v => v.length >= 3);
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = Math.max(0.15, Math.min(0.35, span / 40));
  let rad = '';
  let idx = 0;
  for (let x = minX; x < maxX - 1e-9; x += cell) {
    const x2 = Math.min(maxX, x + cell);
    for (let y = minY; y < maxY - 1e-9; y += cell) {
      const y2 = Math.min(maxY, y + cell);
      const c = [(x + x2) / 2, (y + y2) / 2];
      if (!pointInPoly2(c, footprint)) continue;
      if (holePolys.some(h => pointInPoly2(c, h))) continue;
      rad += polygon(mat, `${PFX}ceiling_${idx++}`, [
        [x, y2, H],
        [x2, y2, H],
        [x2, y, H],
        [x, y, H],
      ]);
    }
  }
  return rad;
}

/**
 * Convert measured transmittance VT to Radiance glass transmissivity.
 * Formula from Radiance glass.c (line 32 comment):
 *   tn = (sqrt(0.8402528435 + 0.0072522239·Tn²) - 0.9166530661) / 0.0036261119 / Tn
 * Validated: VT=0.750 → t=0.8172 ≈ the 0.817 used in all test scenes.
 */
export function vtToTransmissivity(Tn) {
  return (Math.sqrt(0.8402528435 + 0.0072522239 * Tn * Tn) - 0.9166530661) / 0.0036261119 / Tn;
}

function f(v) {
  if (Math.abs(v) >= 100 || (v !== 0 && Math.abs(v) < 0.001)) return v.toExponential(4);
  return parseFloat(v.toPrecision(6)).toString();
}

function maxFootprintSpan(footprint) {
  const xs = footprint.map(p => p[0]);
  const ys = footprint.map(p => p[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
