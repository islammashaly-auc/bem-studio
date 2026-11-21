/**
 * Browser-compatible CBDM pipeline — mirrors cbdm.mjs using browser-radiance.mjs.
 *
 * Identical logic to cbdm.mjs except Radiance WASM functions are loaded via
 * browser-radiance.mjs (fetch + dynamic import) rather than Node.js require().
 */

import { runGendaymtx, runOconv, runRcontrib } from './browser-radiance.mjs?v=multizone-20260706';
import { parseMatrix, multiplyDC }              from './matrix.mjs';
import { computeSDA, computeASE, computeUDI }   from './metrics.mjs';
import { sha256Hex }                            from './browser-hash.mjs?v=insecure-context-20261011';

const GLOW_SKY_RAD  = 'void glow sky_mat\n0\n0\n4  1 1 1  0\n\nsky_mat source sky\n0\n0\n4  0 0 1  180\n';
const LIGHT_SKY_RAD = 'void light sky_mat\n0\n0\n3  1 1 1\n\nsky_mat source sky\n0\n0\n4  0 0 1  180\n';

const DEFAULT_RENDER_SETTINGS = Object.freeze({ ab: 0, ad: 350, as: 0, aa: 0, lw: 0.002 });

// Exact in-worker caches. Entries contain the same parsed Float64 matrices the
// uncached pipeline would produce; no precision conversion or approximation is
// involved. Cache sizes are deliberately small because annual sky matrices are
// large (~60 MB for the full+direct MF=1 pair).
const CACHE_SCHEMA = 'cbdm-exact-v1';
const _skyCache = new Map();
const _octreeCache = new Map();
const _dcCache = new Map();
const _resultCache = new Map();

function cacheGet(cache, key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(cache, key, value, maxEntries) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  return value;
}

async function hashBuffer(buffer) {
  return sha256Hex(buffer);
}

async function hashText(text) {
  return hashBuffer(new TextEncoder().encode(text));
}

async function hashSceneFiles(sceneFiles) {
  const files = await Promise.all(sceneFiles.map(async file => [file.name, await hashBuffer(file.data)]));
  return hashText(JSON.stringify(files));
}

function normalizeRenderSettings(src = {}, fallback = {}) {
  const r = { ...DEFAULT_RENDER_SETTINGS, ...fallback, ...(src || {}) };
  return {
    ab: Math.max(0, Math.round(Number.isFinite(+r.ab) ? +r.ab : 0)),
    ad: Math.max(0, Math.round(Number.isFinite(+r.ad) ? +r.ad : 350)),
    as: Math.max(0, Math.round(Number.isFinite(+r.as) ? +r.as : 0)),
    aa: Math.max(0, Number.isFinite(+r.aa) ? +r.aa : 0),
    lw: Math.max(0, Number.isFinite(+r.lw) ? +r.lw : 0.002),
  };
}

function rcontribRenderArgs(r) {
  return ['-ab', String(r.ab), '-ad', String(r.ad), '-as', String(r.as), '-aa', String(r.aa), '-lw', String(r.lw)];
}

export async function runCBDM(sceneFiles, sensorText, weaData, opts = {}) {
  const {
    mf           = 1,
    ab           = 2,
    c            = 1,
    luxSDA       = 300,
    fractionSDA  = 0.5,
    luxASE       = 1000,
    hoursASE     = 250,
    onProgress   = null,
    radiance     = null,
    runRcontribSDA = null,
  } = opts;
  const sdaRender = normalizeRenderSettings(radiance?.sda, { ab });
  const aseRender = normalizeRenderSettings(radiance?.ase, { ab: 0 });

  const nPatches = mf * mf * 144 + 1;
  const [sceneKey, weaKey, sensorKey] = await Promise.all([
    hashSceneFiles(sceneFiles),
    hashBuffer(weaData),
    hashText(sensorText),
  ]);
  const renderKey = JSON.stringify({ mf, c, nPatches, sdaRender, aseRender,
    parallel: !!runRcontribSDA, schema: CACHE_SCHEMA });
  const resultKey = `${sceneKey}:${weaKey}:${sensorKey}:${renderKey}:` +
    JSON.stringify({ luxSDA, fractionSDA, luxASE, hoursASE });
  const cachedResult = cacheGet(_resultCache, resultKey);
  if (cachedResult) {
    onProgress?.('cached result');
    return cachedResult;
  }

  onProgress?.('oconv');
  const enc = new TextEncoder();
  const glowSkyFile  = { name: 'sky.rad', data: enc.encode(GLOW_SKY_RAD).buffer };
  const lightSkyFile = { name: 'sky.rad', data: enc.encode(LIGHT_SKY_RAD).buffer };
  let octrees = cacheGet(_octreeCache, sceneKey);
  if (!octrees) {
    const [octSdaBuf, octAseBuf] = await Promise.all([
      runOconv([glowSkyFile,  ...sceneFiles]),
      runOconv([lightSkyFile, ...sceneFiles]),
    ]);
    octrees = cacheSet(_octreeCache, sceneKey, { octSdaBuf, octAseBuf }, 3);
  }
  const { octSdaBuf, octAseBuf } = octrees;

  onProgress?.('sky');
  const skyKey = `${weaKey}:${mf}`;
  const skyPromise = (async () => {
    let skies = cacheGet(_skyCache, skyKey);
    if (!skies) {
      const mfArg = String(mf);
      const [skyFullBuf, skyDirectBuf] = await Promise.all([
        runGendaymtx(['-m', mfArg],       weaData),
        runGendaymtx(['-m', mfArg, '-d'], weaData),
      ]);
      console.debug('[cbdm] gendaymtx full output bytes:', skyFullBuf.byteLength,
        '| direct bytes:', skyDirectBuf.byteLength);
      skies = cacheSet(_skyCache, skyKey, {
        skyFull: parseMatrix(new TextDecoder().decode(skyFullBuf)),
        skyDirect: parseMatrix(new TextDecoder().decode(skyDirectBuf)),
      }, 1);
    }
    return skies;
  })();

  onProgress?.('sDA DCs');
  const sensorLines    = sensorText.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const expandedSensor = sensorLines.flatMap(l => Array(c).fill(l)).join('\n') + '\n';
  const sensorBuf      = new TextEncoder().encode(expandedSensor).buffer;

  const aseArgs = [
    '-u-', '-V-', '-fa', '-I',
    ...rcontribRenderArgs(aseRender), '-c', String(c),
    '-f', 'reinhartb.cal',
    '-bn', String(nPatches), '-b', 'rbin',
    '-m', 'sky_mat', '/ase.oct',
  ];
  const aseFsFiles = [
    { name: 'ase.oct', data: octAseBuf },
    { name: 'stdin',   data: sensorBuf },
  ];

  const dcKey = `${sceneKey}:${sensorKey}:${renderKey}`;
  const dcPromise = (async () => {
    let dcs = cacheGet(_dcCache, dcKey);
    if (!dcs) {
      let dcFull, dcDirect;
      if (runRcontribSDA) {
        const [dcFullResult, dcDirectBuf] = await Promise.all([
          runRcontribSDA({ octSdaBuf, sensorLines, ab: sdaRender.ab, c, nPatches, radiance: sdaRender }),
          runRcontrib(aseArgs, aseFsFiles),
        ]);
        dcFull   = dcFullResult;
        dcDirect = parseMatrix(new TextDecoder().decode(dcDirectBuf));
      } else {
        const sdaFsFiles = [
          { name: 'sda.oct', data: octSdaBuf },
          { name: 'stdin',   data: sensorBuf },
        ];
        const [dcFullBuf, dcDirectBuf] = await Promise.all([
          runRcontrib([
            '-u-', '-V-', '-fa', '-I',
            ...rcontribRenderArgs(sdaRender), '-c', String(c),
            '-f', 'reinhartb.cal',
            '-bn', String(nPatches), '-b', 'rbin',
            '-m', 'sky_mat', '/sda.oct',
          ], sdaFsFiles),
          runRcontrib(aseArgs, aseFsFiles),
        ]);
        dcFull   = parseMatrix(new TextDecoder().decode(dcFullBuf));
        dcDirect = parseMatrix(new TextDecoder().decode(dcDirectBuf));
      }
      dcs = cacheSet(_dcCache, dcKey, { dcFull, dcDirect }, 4);
    }
    return dcs;
  })();

  // Sky generation and daylight coefficients depend only on the completed
  // octrees, so overlap them. This preserves both numerical pipelines while
  // removing the annual-sky stage from the cold-run critical path.
  const [{ skyFull, skyDirect }, { dcFull, dcDirect }] = await Promise.all([
    skyPromise,
    dcPromise,
  ]);

  onProgress?.('metrics');
  const luxFull   = multiplyDC(dcFull,   skyFull);
  const luxDirect = multiplyDC(dcDirect, skyDirect);

  const sdaResult = computeSDA(luxFull,   { luxThreshold: luxSDA, fraction: fractionSDA });
  const aseResult = computeASE(luxDirect, { luxThreshold: luxASE, hourThreshold: hoursASE });
  const udiResult = computeUDI(luxFull);

  return cacheSet(_resultCache, resultKey,
    { sda: sdaResult, ase: aseResult, udi: udiResult, luxFull, luxDirect }, 2);
}

/**
 * Progressive / adaptive CBDM — browser version.
 * Same logic as cbdm.mjs:runProgressiveCBDM but uses browser-radiance.mjs.
 */
export async function runProgressiveCBDM(sceneFiles, sensorText, weaData, opts = {}) {
  const {
    mf          = 1,
    ab          = 6,
    luxSDA      = 300,
    fractionSDA = 0.5,
    luxASE      = 1000,
    hoursASE    = 250,
    onProgress  = null,
    onPassResult = null,
    radiance    = null,
    runRcontribSDA = null,
  } = opts;
  const sdaRender = normalizeRenderSettings(radiance?.sda, { ab });
  const aseRender = normalizeRenderSettings(radiance?.ase, { ab: 0 });

  const nPatches = mf * mf * 144 + 1;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  onProgress?.('oconv');
  const glowSkyFile  = { name: 'sky.rad', data: enc.encode(GLOW_SKY_RAD).buffer };
  const lightSkyFile = { name: 'sky.rad', data: enc.encode(LIGHT_SKY_RAD).buffer };
  const [octSdaBuf, octAseBuf] = await Promise.all([
    runOconv([glowSkyFile,  ...sceneFiles]),
    runOconv([lightSkyFile, ...sceneFiles]),
  ]);

  onProgress?.('sky');
  const mfArg = String(mf);
  const [skyFullBuf, skyDirectBuf] = await Promise.all([
    runGendaymtx(['-m', mfArg],       weaData),
    runGendaymtx(['-m', mfArg, '-d'], weaData),
  ]);
  const skyFull   = parseMatrix(dec.decode(skyFullBuf));
  const skyDirect = parseMatrix(dec.decode(skyDirectBuf));

  const sensorLines = sensorText.split('\n').filter(l => l.trim() && !l.startsWith('#'));

  const ASE_C = 1000;
  const aseExpanded  = sensorLines.flatMap(l => Array(ASE_C).fill(l)).join('\n') + '\n';
  const aseSensorBuf = enc.encode(aseExpanded).buffer;
  const aseArgs = [
    '-u-', '-V-', '-fa', '-I',
    ...rcontribRenderArgs(aseRender), '-c', String(ASE_C),
    '-f', 'reinhartb.cal',
    '-bn', String(nPatches), '-b', 'rbin',
    '-m', 'sky_mat', '/ase.oct',
  ];
  const aseFsFiles = [
    { name: 'ase.oct', data: octAseBuf },
    { name: 'stdin',   data: aseSensorBuf },
  ];

  let aseDcMatrix    = null;
  let aseResultFinal = null;

  const asePromise = runRcontrib(aseArgs, aseFsFiles).then(buf => {
    aseDcMatrix    = parseMatrix(dec.decode(buf));
    const luxDir   = multiplyDC(aseDcMatrix, skyDirect);
    aseResultFinal = computeASE(luxDir, { luxThreshold: luxASE, hourThreshold: hoursASE });
    return aseResultFinal;
  });

  const PASS_C = [200, 500, 1000];
  const CONVERGENCE_BORDER = 0.02;

  let prevSdaResult  = null;
  let finalSdaResult = null;
  let finalLuxFull   = null;
  let converged      = false;
  let passes         = 0;
  let totalSamples   = 0;

  function sdaPassArgs(cPass) {
    return [
      '-u-',  // always seed=0 — pass 2 at c=1000 == validated reference
      '-V-', '-fa', '-I',
      ...rcontribRenderArgs(sdaRender), '-c', String(cPass),
      '-f', 'reinhartb.cal',
      '-bn', String(nPatches), '-b', 'rbin',
      '-m', 'sky_mat', '/sda.oct',
    ];
  }

  async function runSdaPass(cPass) {
    if (runRcontribSDA) {
      return runRcontribSDA({ octSdaBuf, sensorLines, ab: sdaRender.ab, c: cPass, nPatches, useSeedPlus: false, radiance: sdaRender });
    }
    const expanded   = sensorLines.flatMap(l => Array(cPass).fill(l)).join('\n') + '\n';
    const sdaFsFiles = [
      { name: 'sda.oct', data: octSdaBuf },
      { name: 'stdin',   data: enc.encode(expanded).buffer },
    ];
    const buf = await runRcontrib(sdaPassArgs(cPass), sdaFsFiles);
    return parseMatrix(dec.decode(buf));
  }

  for (let pi = 0; pi < PASS_C.length; pi++) {
    const cPass = PASS_C[pi];
    passes++;

    onProgress?.(`sDA pass ${passes}/${PASS_C.length}`);

    let dcPass;
    if (pi === 0) {
      const [p0dc] = await Promise.all([runSdaPass(cPass), asePromise]);
      dcPass = p0dc;
    } else {
      dcPass = await runSdaPass(cPass);
    }

    totalSamples    = cPass;
    const luxFull   = multiplyDC(dcPass, skyFull);
    const sdaResult = computeSDA(luxFull, { luxThreshold: luxSDA, fraction: fractionSDA });

    converged = (pi > 0) && _isProgressiveConverged(sdaResult, prevSdaResult, CONVERGENCE_BORDER);

    onPassResult?.({
      sda: sdaResult,
      ase: aseResultFinal,
      luxFull,
      totalSamples,
      passes,
      converged,
    });

    prevSdaResult  = sdaResult;
    finalSdaResult = sdaResult;
    finalLuxFull   = luxFull;

    if (converged) break;
  }

  await asePromise;
  const luxDirect = multiplyDC(aseDcMatrix, skyDirect);

  return {
    sda: finalSdaResult,
    ase: aseResultFinal,
    udi: computeUDI(finalLuxFull),
    luxFull: finalLuxFull,
    luxDirect,
    totalSamples,
    passes,
    converged,
  };
}

function _isProgressiveConverged(curr, prev, border = 0.02) {
  if (!prev) return false;
  const curCount  = curr.perSensor.filter(f => f >= 0.5).length;
  const prevCount = prev.perSensor.filter(f => f >= 0.5).length;
  if (curCount !== prevCount) return false;
  for (let i = 0; i < curr.perSensor.length; i++) {
    const cf = curr.perSensor[i], pf = prev.perSensor[i];
    if ((cf > 0.5 - border && cf < 0.5 + border) ||
        (pf > 0.5 - border && pf < 0.5 + border)) {
      if ((cf >= 0.5) !== (pf >= 0.5)) return false;
    }
  }
  return true;
}
