/**
 * CBDM simulation Worker — browser Web Worker variant.
 *
 * Identical logic to src/worker.mjs but uses browser Web Worker APIs
 * (self.onmessage / self.postMessage) instead of Node.js worker_threads.
 *
 * Loaded as a module worker from the page:
 *   new Worker('/src/browser-worker.mjs?v=custom-grid-exterior-20260701', { type: 'module' })
 *
 * Message in  — same schema as worker.mjs
 * Messages out — same schema as worker.mjs
 */

import { generateScene, generateFloorScene, generateBuildingScene } from './scene.mjs?v=wall-hole-20260815';
import { generateGrid, sensorsToText, rotateSensorsToScene, sortSensorsCanonical, buildFloorSensorStream } from './grid.mjs?v=multizone-20260706';
import { runCBDM } from './browser-cbdm.mjs?v=radiance-fast-20260810';
import { runEpw2Wea }                from './browser-radiance.mjs?v=multizone-20260706';
import { parseMatrix }               from './matrix.mjs';
import { sha256Hex }                 from './browser-hash.mjs?v=insecure-context-20261011';

const MAX_WORKERS = 8;
const NATIVE_RADIANCE_STATUS_URL = '/api/radiance/status';
const NATIVE_RADIANCE_BATCH_URL  = '/api/radiance/rcontrib-batch';
let nativeRadianceStatusPromise = null;
// Classic worker: importScripts('/build/rcontrib.js') avoids blob-URL dynamic
// import(), which silently hangs in nested module workers without COEP headers.
const RCONTRIB_WORKER_URL = new URL('./browser-rcontrib-worker-classic.js?v=radiance-fast-20260810', import.meta.url);

function rcontribRenderArgs(r = {}) {
  return [
    '-ab', String(r.ab ?? 6),
    '-ad', String(r.ad ?? 350),
    '-as', String(r.as ?? 0),
    '-aa', String(r.aa ?? 0),
    '-lw', String(r.lw ?? 0.002),
  ];
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function nativeRadianceStatus() {
  if (!nativeRadianceStatusPromise) {
    nativeRadianceStatusPromise = fetch(NATIVE_RADIANCE_STATUS_URL, { cache: 'no-store' })
      .then(async response => response.ok ? response.json() : null)
      .then(status => status?.protocol === 1 && status.available ? status : null)
      .catch(() => null);
  }
  return nativeRadianceStatusPromise;
}

function mergeDCRows(dcRows, expectedRows, expectedCols) {
  if (dcRows.length !== expectedRows || !dcRows.length) {
    throw new Error(`rcontrib returned ${dcRows.length} rows; expected ${expectedRows}`);
  }
  const { ncomp, ncols } = dcRows[0];
  if (ncomp !== 3 || ncols !== expectedCols) {
    throw new Error(`rcontrib returned ${ncols}×${ncomp}; expected ${expectedCols}×3`);
  }
  const merged = new Float64Array(expectedRows * ncols * ncomp);
  for (let sensorIdx = 0; sensorIdx < expectedRows; sensorIdx++) {
    const row = dcRows[sensorIdx];
    if (row.nrows !== 1 || row.ncols !== ncols || row.ncomp !== ncomp) {
      throw new Error(`rcontrib sensor ${sensorIdx} returned an inconsistent matrix`);
    }
    merged.set(row.data, sensorIdx * ncols * ncomp);
  }
  return { nrows: expectedRows, ncols, ncomp, data: merged };
}

async function tryNativeRcontribSDA({ octSdaBuf, sensorLines, ab, c, nPatches, radiance }) {
  const status = await nativeRadianceStatus();
  if (!status) return null;

  const render = { ab, ...(radiance || {}) };
  const response = await fetch(NATIVE_RADIANCE_BATCH_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 1,
      octree: bufferToBase64(octSdaBuf),
      sensors: sensorLines,
      settings: {
        ab: render.ab ?? 6,
        ad: render.ad ?? 350,
        as: render.as ?? 0,
        aa: render.aa ?? 0,
        lw: render.lw ?? 0.002,
        c,
        nPatches,
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error || `HTTP ${response.status}`);
  }
  const result = await response.json();
  if (result?.protocol !== 1 || !Array.isArray(result.rows)) {
    throw new Error('native Radiance returned an invalid response');
  }
  const parsedRows = result.rows.map(text => parseMatrix(text));
  console.debug(`[daylight] native Radiance: ${result.workers} workers${result.cached ? ', exact cache hit' : ''}`);
  return mergeDCRows(parsedRows, sensorLines.length, nPatches);
}

async function runRcontribSDAParallel({ octSdaBuf, sensorLines, ab, c, nPatches, radiance = null }) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const nWorkers = Math.min(sensorLines.length, navigator.hardwareConcurrency ?? 4, MAX_WORKERS);

  try {
    const nativeResult = await tryNativeRcontribSDA({
      octSdaBuf, sensorLines, ab, c, nPatches, radiance,
    });
    if (nativeResult) return nativeResult;
  } catch (error) {
    // The accelerator is optional. A stale/missing local binary or an API
    // failure must never make daylight unavailable; retain the validated WASM
    // pool as the exact fallback for this run.
    console.warn(`[daylight] native Radiance unavailable; using WASM: ${error?.message || error}`);
  }

  const sdaArgs = [
    '-u-',  // fixed seed=0 — reproducible, matches validated reference
    '-V-', '-fa', '-I',
    ...rcontribRenderArgs({ ab, ...(radiance || {}) }), '-c', String(c),
    '-f', 'reinhartb.cal',
    '-bn', String(nPatches), '-b', 'rbin',
    '-m', 'sky_mat', '/sda.oct',
  ];

  function startWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(RCONTRIB_WORKER_URL); // classic worker
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.type !== 'ready') return;
        if (msg.error) reject(new Error(`rcontrib worker init: ${msg.error}`));
        else resolve(w);
      };
      w.onerror = (e) => reject(new Error(e.message));
      // Clone the octree once per pool worker, not once per sensor.
      w.postMessage({ type: 'init', args: sdaArgs, octBuf: octSdaBuf, octName: 'sda.oct' });
    });
  }

  function runOneSensor(w, sensorIdx) {
    const sensorBuf = enc.encode(Array(c).fill(sensorLines[sensorIdx]).join('\n') + '\n').buffer;
    return new Promise((resolve, reject) => {
      const taskId = sensorIdx;
      w.onmessage = (e) => {
        const msg = e.data;
        if (msg.type !== 'result' || msg.taskId !== taskId) return;
        if (msg.ok) resolve({ sensorIdx: msg.sensorIdx, dcBuf: msg.dcBuf });
        else reject(new Error(`sensor ${sensorIdx}: ${msg.error}`));
      };
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ type: 'run', taskId, sensorIdx, sensorBuf }, [sensorBuf]);
    });
  }

  const workers = await Promise.all(Array.from({ length: nWorkers }, startWorker));
  const dcRows = new Array(sensorLines.length);
  let nextTask = 0;

  async function runWorkerSlot(w) {
    while (nextTask < sensorLines.length) {
      const idx = nextTask++;
      const result = await runOneSensor(w, idx);
      dcRows[result.sensorIdx] = parseMatrix(dec.decode(result.dcBuf));
    }
  }

  try {
    await Promise.all(workers.map(runWorkerSlot));
  } finally {
    workers.forEach(w => w.terminate());
  }

  return mergeDCRows(dcRows, sensorLines.length, nPatches);
}

/**
 * Per-zone sDA/ASE aggregates from the combined stream (5-C.3). Per-sensor
 * values are independent, so zone metrics are pure slices of the stream —
 * the validated computeSDA/computeASE outputs are used as-is. LM-83
 * thresholds: sDA counts sensors with occupied fraction ≥ 0.5; ASE counts
 * sensors with > 250 direct-sun hours.
 */
function perZoneResults(zones, zoneIds, sdaPerSensor, aseHoursPerSensor) {
  return zones.map(z => {
    let n = 0, nPass = 0, nAse = 0;
    for (let i = 0; i < zoneIds.length; i++) {
      if (zoneIds[i] !== z.zoneId) continue;
      n++;
      if (sdaPerSensor[i] >= 0.5)    nPass++;
      if (aseHoursPerSensor[i] > 250) nAse++;
    }
    return { zoneId: z.zoneId, nSensors: n, sda: n ? nPass / n : 0, ase: n ? nAse / n : 0 };
  });
}

let runStart = 0;
let climateCache = null;

async function climateKey(epw, climateFileName) {
  const kind = (climateFileName ?? '').toLowerCase().endsWith('.epw') ? 'epw' : 'wea';
  return `${kind}:${await sha256Hex(epw)}`;
}

function post(msg) {
  self.postMessage(msg);
}

function progress(step) {
  post({ type: 'progress', step, elapsed: Date.now() - runStart });
}

self.onmessage = async (e) => {
  if (e.data.type !== 'run') return;

  // env_studio sends `epw`; the standalone browser harness historically
  // sends an already-converted `wea`. Keep both message forms supported.
  const { climateFileName, scene, sim = {} } = e.data;
  const epw = e.data.epw ?? e.data.wea;
  const { ab = 6, MF: mf = 1, spacing = 0.5, offset = 0.5, sensorHeight = 0.8, radiance = null } = sim;

  try {
    runStart = Date.now();

    // Derive WEA from EPW if needed; WEA files are used directly.
    progress('climate');
    const key = await climateKey(epw, climateFileName);
    let wea = climateCache?.key === key ? climateCache.wea : null;
    if (!wea) {
      wea = (climateFileName ?? '').toLowerCase().endsWith('.epw')
        ? await runEpw2Wea(epw)
        : epw;
      // A single climate entry is enough for the common edit-and-rerun loop,
      // while bounding the annual weather data retained by this worker.
      climateCache = { key, wea };
    }

    progress('scene');
    const isMulti    = !!scene.multiZone;
    // See worker.mjs for why multiLevel is checked separately from isMulti.
    const radString  = scene.multiLevel ? generateBuildingScene(scene)
                      : isMulti          ? generateFloorScene(scene)
                      :                    generateScene(scene);
    const sceneFiles = [
      { name: 'room.rad', data: new TextEncoder().encode(radString).buffer },
    ];

    // Generate in room (BTM) coordinates, then rotate to scene/geographic space.
    // scene.btmFootprint is the zone.footprint as drawn (always axis-aligned for
    // UI drawings), so the count is invariant to trueNorth.  Falls back to
    // scene.footprint for callers that pre-build scene without btmFootprint.
    let sensors, zoneIds = null;
    if (isMulti) {
      ({ sensors, zoneIds } = buildFloorSensorStream(scene, { spacing, offset, wph: sensorHeight }));
    } else {
      const customSensors = Array.isArray(scene.customSensors) ? scene.customSensors : null;
      const btmSensors = customSensors && customSensors.length
        ? customSensors
        : generateGrid(scene.btmFootprint ?? scene.footprint, scene.height, { spacing, offset, wph: sensorHeight });
      sensors = customSensors && customSensors.length
        ? customSensors
        : (scene.centroid
          ? sortSensorsCanonical(rotateSensorsToScene(btmSensors, scene.trueNorth ?? 0, scene.centroid))
          : btmSensors);
    }
    const sensorText = sensorsToText(sensors);

    // ── CBDM pipeline (validated: ab=6, c=1000, seed=0) ───────────────────
    const { sda, ase, luxFull } = await runCBDM(sceneFiles, sensorText, wea, {
      mf,
      ab,
      radiance,
      c:              1000,
      onProgress:     (step) => progress(step),
      runRcontribSDA: runRcontribSDAParallel,
    });

    const luxF32 = new Float32Array(luxFull.data);
    post({
      type:            'result',
      sda:             sda.sda,
      ase:             ase.ase,
      occupiedHours:   sda.occupiedHours,
      sensors,
      footprint:       isMulti ? [] : scene.footprint,
      sensorFractions: sda.perSensor,
      directHours:     ase.perSensor,
      luxFull:         luxF32,
      nHours:          luxFull.nHours,
      ...(isMulti ? {
        zoneIds,
        anchor:      scene.anchor,
        zoneResults: perZoneResults(scene.zones, zoneIds, sda.perSensor, ase.perSensor),
      } : {}),
    }, [luxF32.buffer]);

  } catch (err) {
    post({ type: 'error', message: err.message ?? String(err) });
  }
};
