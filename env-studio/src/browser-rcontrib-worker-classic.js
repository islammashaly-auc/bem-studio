// Classic Web Worker — per-sensor rcontrib computation.
//
// Uses importScripts to load the Emscripten factory so it works without
// Cross-Origin-Embedder-Policy headers (python http.server, nginx, etc.).
// Module workers that nest deeper module workers need COEP for import(blobUrl);
// classic workers with importScripts have no such restriction.
//
// Spawned by browser-worker.mjs as: new Worker(url)  (no { type:'module' }).
//
// Persistent-pool protocol:
//   in:  { type:'init', args, octBuf, octName }
//   out: { type:'ready' }
//   in:  { type:'run', taskId, sensorIdx, sensorBuf }
//   out: { type:'result', taskId, sensorIdx, ok, dcBuf|error }
//
// The worker and Emscripten factory are reused, but every task still creates a
// fresh WASM Module.  Radiance's process-global state therefore starts clean
// for every sensor, preserving the validated per-sensor seed=0 ray sequence.

var _rcontribFactory = null;
var _args = null;
var _octBuf = null;
var _octName = null;

function getFactory() {
  if (!_rcontribFactory) {
    self.importScripts(new URL('../build/rcontrib.js?v=radiance-fast-20260810', self.location.href).href);
    // rcontrib.js assigns: var Module = (()=>{ return async function(opts){} })();
    // importScripts runs the script in the classic-worker global scope, so
    // Module is now accessible as a global variable here.
    _rcontribFactory = self.Module; // importScripts puts Module on the worker global
  }
  return _rcontribFactory;
}

self.onmessage = async function (e) {
  var msg     = e.data;

  if (msg.type === 'init') {
    try {
      _args = msg.args;
      _octBuf = msg.octBuf;
      _octName = msg.octName;
      getFactory();
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'ready', error: (err && err.message) ? err.message : String(err) });
    }
    return;
  }

  if (msg.type !== 'run') return;

  var sensorBuf = msg.sensorBuf;

  try {
    var createRcontrib = getFactory();

    var stdinArr = new Uint8Array(sensorBuf);
    var stdinPos = 0;
    var outputLines = [];

    var mod = await createRcontrib({
      locateFile:   function (f) { return new URL('../build/' + f + '?v=radiance-fast-20260810', self.location.href).href; },
      noInitialRun: true,
      stdin:        function () { return stdinPos < stdinArr.length ? stdinArr[stdinPos++] : null; },
      print:        function (s) { outputLines.push(s); },
      printErr:     function () {},
    });

    mod.FS.writeFile('/' + _octName, new Uint8Array(_octBuf));

    // Emscripten callMain() prepends thisProgram to the array it receives.
    // Pass a copy so the persistent worker's canonical argv stays unchanged.
    try { mod.callMain(_args.slice()); } catch (_) {}

    var text   = outputLines.join('\n') + (outputLines.length ? '\n' : '');
    var dcBuf  = new TextEncoder().encode(text).buffer;
    self.postMessage({
      type: 'result', taskId: msg.taskId, sensorIdx: msg.sensorIdx,
      ok: true, dcBuf: dcBuf
    }, [dcBuf]);

  } catch (err) {
    self.postMessage({
      type: 'result', taskId: msg.taskId, sensorIdx: msg.sensorIdx,
      ok: false, error: (err && err.message) ? err.message : String(err)
    });
  }
};
