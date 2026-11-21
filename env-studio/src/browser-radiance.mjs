/**
 * Browser-compatible wrapper for Radiance WASM binaries.
 *
 * Mirrors the public API of radiance.mjs (runOconv, runGendaymtx, runRcontrib,
 * runRtrace) but loads the Emscripten factories via fetch + dynamic import
 * instead of Node.js require(), so it works in browser module workers.
 *
 * WASM files are resolved from /build/<name>.wasm via a locateFile override.
 *
 * Usage in browser module worker:
 *   import { runOconv, runGendaymtx, runRcontrib } from './browser-radiance.mjs';
 */

const LOCATE_FILE = (f) => new URL(`../build/${f}`, import.meta.url).href;

const _cache = {};

async function loadFactory(name) {
  if (_cache[name]) return _cache[name];

  // Fetch the Emscripten JS bundle and append an ES default export so
  // dynamic import() can retrieve the factory function.
  // Most Emscripten outputs here use: var Module = (()=>{ ... })().
  // epw2wea was built with -sEXPORT_NAME=createEpw2WeaModule, so it exposes
  // that symbol instead. Export whichever factory the bundle actually defines.
  const resp = await fetch(new URL(`../build/${name}.js`, import.meta.url), { cache: 'no-store' });
  if (!resp.ok) throw new Error(`browser-radiance: failed to fetch /build/${name}.js (HTTP ${resp.status})`);
  const text = await resp.text();

  const blob = new Blob([text, `
const __radianceFactory =
  typeof Module !== 'undefined' ? Module :
  typeof createEpw2WeaModule !== 'undefined' ? createEpw2WeaModule :
  undefined;
if (!__radianceFactory) throw new Error('browser-radiance: no Emscripten factory found in /build/${name}.js');
export default __radianceFactory;
`], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  try {
    const mod = await import(url);
    _cache[name] = mod.default;
    return mod.default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function mountFiles(mod, files) {
  for (const { name, data } of files) {
    const path = name.startsWith('/') ? name : `/${name}`;
    mod.FS.writeFile(path, new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer));
  }
}

function toTransferableBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

export async function runOconv(inputFiles) {
  if (!inputFiles?.length) throw new Error('runOconv: inputFiles must be non-empty');

  const createOconv = await loadFactory('oconv');
  const mod = await createOconv({ locateFile: LOCATE_FILE, noInitialRun: true, printErr: () => {} });

  const paths = inputFiles.map(({ name }) => name.startsWith('/') ? name : `/${name}`);
  mountFiles(mod, inputFiles);

  mod.FS.writeFile('/_oconv_out', new Uint8Array(0));
  const capStream  = mod.FS.open('/_oconv_out', 'w+');
  const origStdout = mod.FS.streams[1];
  mod.FS.streams[1] = capStream;

  try { mod.callMain(['-f', ...paths]); } catch (_) {}

  mod.FS.streams[1] = origStdout;

  const result = mod.FS.readFile('/_oconv_out');
  if (!result.byteLength) throw new Error('oconv: empty output — check scene files for errors');
  return toTransferableBuffer(result);
}

export async function runGendaymtx(args, weaData) {
  if (!args?.length) throw new Error('runGendaymtx: args must be non-empty');
  if (!weaData)      throw new Error('runGendaymtx: weaData is required');

  const stdinBuf = new Uint8Array(weaData instanceof ArrayBuffer ? weaData : weaData.buffer);
  let stdinPos = 0;

  const outputLines = [];
  const createGendaymtx = await loadFactory('gendaymtx');
  const mod = await createGendaymtx({
    locateFile: LOCATE_FILE,
    noInitialRun: true,
    stdin:    () => stdinPos < stdinBuf.length ? stdinBuf[stdinPos++] : null,
    print:    (s) => outputLines.push(s),
    printErr: () => {},
  });

  try { mod.callMain([...args]); } catch (_) {} // copy: Emscripten callMain unshifts thisProgram into the array it is given

  const text = outputLines.join('\n') + (outputLines.length ? '\n' : '');
  return new TextEncoder().encode(text).buffer;
}

export async function runRcontrib(args, inputFiles) {
  if (!args?.length) throw new Error('runRcontrib: args must be non-empty');

  const stdinEntry = inputFiles?.find(f => f.name === 'stdin' || f.name === '-');
  const fsFiles    = (inputFiles ?? []).filter(f => f !== stdinEntry);

  const stdinBuf = stdinEntry
    ? new Uint8Array(stdinEntry.data instanceof ArrayBuffer ? stdinEntry.data : stdinEntry.data.buffer)
    : new Uint8Array(0);
  let stdinPos = 0;

  const outputLines = [];
  const createRcontrib = await loadFactory('rcontrib');
  const mod = await createRcontrib({
    locateFile: LOCATE_FILE,
    noInitialRun: true,
    stdin:    () => stdinPos < stdinBuf.length ? stdinBuf[stdinPos++] : null,
    print:    (s) => outputLines.push(s),
    printErr: () => {},
  });

  mountFiles(mod, fsFiles);

  try { mod.callMain([...args]); } catch (_) {} // copy: Emscripten callMain unshifts thisProgram into the array it is given

  const text = outputLines.join('\n') + (outputLines.length ? '\n' : '');
  return new TextEncoder().encode(text).buffer;
}

export async function runEpw2Wea(epwData) {
  if (!epwData) throw new Error('runEpw2Wea: epwData is required');

  const createEpw2Wea = await loadFactory('epw2wea');
  const mod = await createEpw2Wea({
    locateFile:  LOCATE_FILE,
    noInitialRun: true,
    print:    () => {},   // suppress stdout header echo (duplicated in output file)
    printErr: () => {},
  });

  mod.FS.writeFile('/input.epw', new Uint8Array(epwData instanceof ArrayBuffer ? epwData : epwData.buffer));
  try { mod.callMain(['/input.epw', '/output.wea']); } catch (_) {}

  const result = mod.FS.readFile('/output.wea');
  if (!result.byteLength) throw new Error('epw2wea: empty output — check EPW file format');
  return toTransferableBuffer(result);
}

export async function runRtrace(args, inputFiles) {
  if (!args?.length) throw new Error('runRtrace: args must be non-empty');

  const stdinEntry = inputFiles?.find(f => f.name === 'stdin' || f.name === '-');
  const fsFiles    = (inputFiles ?? []).filter(f => f !== stdinEntry);

  const stdinBuf = stdinEntry
    ? new Uint8Array(stdinEntry.data instanceof ArrayBuffer ? stdinEntry.data : stdinEntry.data.buffer)
    : new Uint8Array(0);
  let stdinPos = 0;

  const outputLines = [];
  const createRtrace = await loadFactory('rtrace');
  const mod = await createRtrace({
    locateFile: LOCATE_FILE,
    noInitialRun: true,
    stdin:    () => stdinPos < stdinBuf.length ? stdinBuf[stdinPos++] : null,
    print:    (s) => outputLines.push(s),
    printErr: () => {},
  });

  mountFiles(mod, fsFiles);

  try { mod.callMain([...args]); } catch (_) {} // copy: Emscripten callMain unshifts thisProgram into the array it is given

  const text = outputLines.join('\n') + (outputLines.length ? '\n' : '');
  return new TextEncoder().encode(text).buffer;
}
