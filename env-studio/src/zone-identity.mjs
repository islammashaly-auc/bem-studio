// Zone identity reconciliation — Stage 5-B / B2 (PHASE5B_CONSTRUCTION_UI_PLAN.md §10.3).
//
// Pure function: gives every newly-traced zone (from compileBTM) a persistent,
// user-nameable identity that survives ordinary geometry edits (including
// whole-block translation) across recompiles, without inheriting identity
// across a merge or a split. Self-contained — carries its own snapKey/edgeKey
// so it never needs to agree with any external key convention (only with
// itself, footprint-to-footprint).
//
// See §10.3 for the exact algorithm this file implements verbatim.

function snapKey(p, precision) {
  return `${p.x.toFixed(precision)},${p.y.toFixed(precision)}`;
}

function edgeKey(a, b, precision) {
  const k1 = snapKey(a, precision), k2 = snapKey(b, precision);
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}

function absKeys(footprint) {
  const n = footprint.length;
  const s = new Set();
  for (let i = 0; i < n; i++) s.add(edgeKey(footprint[i], footprint[(i + 1) % n], 3));
  return s;
}

function relKeys(footprint, centroid) {
  const n = footprint.length;
  const rel = footprint.map(p => ({ x: p.x - centroid.x, y: p.y - centroid.y }));
  const s = new Set();
  for (let i = 0; i < n; i++) s.add(edgeKey(rel[i], rel[(i + 1) % n], 2));
  return s;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const k of a) if (b.has(k)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function idOrd(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Numeric-aware ordering for 'zid_<n>' style ids — used only to give the
// returned nextIdentities array a canonical, input-order-independent shape
// (Gate U's permutation-invariance requirement).
function idNumOrd(a, b) {
  const na = /^zid_(\d+)$/.exec(a);
  const nb = /^zid_(\d+)$/.exec(b);
  if (na && nb) return parseInt(na[1], 10) - parseInt(nb[1], 10);
  return idOrd(a, b);
}

function cloneObject(value) {
  return value ? JSON.parse(JSON.stringify(value)) : undefined;
}

/**
 * @param {Array} prevIdentities  [{ id, name, levelIdx, centroid, floorArea, footprint, energyProps, constructions, schedules }]
 * @param {Array} zones           btm.zones (needs id, levelIdx, footprint, floorArea, centroid)
 * @param {number} nextIdNum      monotonic minter, next id to hand out
 * @returns {{ byZoneId: Object, nextIdentities: Array, nextIdNum: number }}
 */
export function reconcileZoneIdentities(prevIdentities, zones, nextIdNum) {
  const zonesSorted = [...zones].sort((a, b) => idOrd(a.id, b.id));
  const prevSorted = [...prevIdentities].sort((a, b) => idOrd(a.id, b.id));

  const zoneData = zonesSorted.map(z => ({
    zone: z,
    abs: absKeys(z.footprint),
    rel: relKeys(z.footprint, z.centroid),
  }));
  const prevData = prevSorted.map(p => ({
    prev: p,
    abs: absKeys(p.footprint),
    rel: relKeys(p.footprint, p.centroid),
  }));

  const matchedZone = new Map(); // zone.id -> prev.id
  const matchedPrev = new Set(); // prev.id

  function centroidDist(c1, c2) {
    return Math.hypot(c1.x - c2.x, c1.y - c2.y);
  }

  // ── Tier 1: exact / near-exact ──────────────────────────────────────────
  const tier1 = [];
  for (const zd of zoneData) {
    for (const pd of prevData) {
      if (zd.zone.levelIdx !== pd.prev.levelIdx) continue;
      const jacAbs = jaccard(zd.abs, pd.abs);
      const cDist = centroidDist(zd.zone.centroid, pd.prev.centroid);
      const areaRatio = Math.min(zd.zone.floorArea, pd.prev.floorArea) / Math.max(zd.zone.floorArea, pd.prev.floorArea);
      const confident = jacAbs >= 0.5 || (cDist <= 0.5 && areaRatio >= 0.85);
      if (confident) tier1.push({ zd, pd, jac: jacAbs, cDist });
    }
  }
  tier1.sort((a, b) =>
    (b.jac - a.jac) ||
    (a.cDist - b.cDist) ||
    idOrd(a.pd.prev.id, b.pd.prev.id) ||
    idOrd(a.zd.zone.id, b.zd.zone.id));
  for (const c of tier1) {
    if (matchedZone.has(c.zd.zone.id) || matchedPrev.has(c.pd.prev.id)) continue;
    matchedZone.set(c.zd.zone.id, c.pd.prev.id);
    matchedPrev.add(c.pd.prev.id);
  }

  // ── Tier 2: translation-invariant rescue (whole-block/whole-building move) ──
  // Evaluated ONLY between zones and identities BOTH left unmatched by Tier 1.
  const tier2 = [];
  for (const zd of zoneData) {
    if (matchedZone.has(zd.zone.id)) continue;
    for (const pd of prevData) {
      if (matchedPrev.has(pd.prev.id)) continue;
      if (zd.zone.levelIdx !== pd.prev.levelIdx) continue;
      const jacRel = jaccard(zd.rel, pd.rel);
      const areaRatio = Math.min(zd.zone.floorArea, pd.prev.floorArea) / Math.max(zd.zone.floorArea, pd.prev.floorArea);
      const confident = jacRel >= 0.5 && areaRatio >= 0.85;
      if (confident) tier2.push({ zd, pd, jac: jacRel, cDist: centroidDist(zd.zone.centroid, pd.prev.centroid) });
    }
  }
  tier2.sort((a, b) =>
    (b.jac - a.jac) ||
    (a.cDist - b.cDist) ||
    idOrd(a.pd.prev.id, b.pd.prev.id) ||
    idOrd(a.zd.zone.id, b.zd.zone.id));
  for (const c of tier2) {
    if (matchedZone.has(c.zd.zone.id) || matchedPrev.has(c.pd.prev.id)) continue;
    matchedZone.set(c.zd.zone.id, c.pd.prev.id);
    matchedPrev.add(c.pd.prev.id);
  }

  // ── Build the result: matched identities refresh geometry, unmatched
  //    zones mint fresh, unmatched identities are dropped. ──
  const prevById = new Map(prevSorted.map(p => [p.id, p]));
  let counter = nextIdNum;
  const byZoneId = {};
  const records = [];
  for (const zd of zoneData) {
    const z = zd.zone;
    const footprint = z.footprint.map(p => ({ x: p.x, y: p.y }));
    const centroid = { x: z.centroid.x, y: z.centroid.y };
    const matchedPrevId = matchedZone.get(z.id);
    let rec;
    if (matchedPrevId) {
      const prev = prevById.get(matchedPrevId);
      rec = {
        id: prev.id,
        name: prev.name ?? null,
        levelIdx: z.levelIdx,
        centroid,
        floorArea: z.floorArea,
        footprint,
        energyProps: prev.energyProps ? { ...prev.energyProps } : undefined,
        constructions: cloneObject(prev.constructions),
        schedules: cloneObject(prev.schedules),
      };
    } else {
      rec = {
        id: `zid_${counter++}`,
        name: null,
        levelIdx: z.levelIdx,
        centroid,
        floorArea: z.floorArea,
        footprint,
        energyProps: undefined,
        constructions: undefined,
        schedules: undefined,
      };
    }
    byZoneId[z.id] = rec;
    records.push(rec);
  }
  records.sort((a, b) => idNumOrd(a.id, b.id));

  return { byZoneId, nextIdentities: records, nextIdNum: counter };
}

// ─────────────────────────────────────────────────────────────────────────
// Stage 5-B / B2 REDESIGN — block-anchored identity, R1
// (PHASE5B_CONSTRUCTION_UI_PLAN.md §11.6/FF-6/FF-8). ADDITIVE exports only;
// everything above this line is byte-unchanged and is reused verbatim as
// the geometric fallback engine for zones a block cannot cleanly own.
//
// These three exports give env_studio.html's ownership test (§11.4 Phase A)
// the SAME snapKey/edgeKey convention this module already uses internally,
// so "does this zone's ring equal this block's own footprint" is answered
// by one shared, tested definition rather than a second implementation.
// ─────────────────────────────────────────────────────────────────────────

function crossZ(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Perpendicular distance from `p` to the infinite line through `a`/`b`.
// Degenerate (a≈b) segments are treated as if every point on them is
// collinear — the far endpoint disappearing under dedupe already collapses
// that case before this is reached in practice.
function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const segLen = Math.hypot(dx, dy);
  if (segLen < 1e-9) return 0;
  return Math.abs(crossZ(a, b, p)) / segLen;
}

/**
 * Normalizes a ring (open polygon, no duplicated closing vertex) for
 * edge-set comparison (§11.2 FF-8): drops consecutive duplicate points
 * (1mm tolerance — also absorbs quantization-collapsed vertices), then
 * iteratively drops collinear vertices (perpendicular distance to the line
 * through their ring-neighbors ≤ 1mm, re-scanning after each removal so a
 * run of several collinear points collapses fully). Never mutates `fp`;
 * always returns a new array. Stops at a 3-vertex minimum (a valid simple
 * polygon can't go below a triangle).
 * @param {Array<{x:number,y:number}>} fp
 * @returns {Array<{x:number,y:number}>}
 */
export function normalizeRing(fp) {
  const dedup = [];
  for (const p of fp) {
    const prev = dedup.length ? dedup[dedup.length - 1] : null;
    if (!prev || Math.abs(prev.x - p.x) >= 1e-3 || Math.abs(prev.y - p.y) >= 1e-3) {
      dedup.push({ x: p.x, y: p.y });
    }
  }
  if (dedup.length > 1) {
    const first = dedup[0], last = dedup[dedup.length - 1];
    if (Math.abs(first.x - last.x) < 1e-3 && Math.abs(first.y - last.y) < 1e-3) dedup.pop();
  }

  let pts = dedup;
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const n = pts.length;
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      if (perpDist(cur, prev, next) <= 1e-3) {
        pts = pts.slice(0, i).concat(pts.slice(i + 1));
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * Public name for the module's internal undirected, 3-decimal-snapped
 * edge-key set (the same convention Tier 1 uses). Callers normalize first
 * via normalizeRing() when the ring may carry T-junction split vertices
 * (§11.2 FF-8) — this function itself does no normalization.
 * @param {Array<{x:number,y:number}>} fp
 * @returns {Set<string>}
 */
export function footprintEdgeSet(fp) {
  return absKeys(fp);
}

/**
 * Set-equality (size + membership) over two edge-key sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
export function edgeSetEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}
