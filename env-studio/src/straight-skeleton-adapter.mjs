// The upstream UMD bundle targets a browser page. Node-based geometry/export
// tests need temporary `self`/`window` aliases, while module workers need the
// same `window` alias to select Emscripten's fetch-capable web branch. The CGAL
// WebAssembly binary is embedded in the bundle, so no secondary fetch is needed.
const addedSelf = typeof globalThis.self === 'undefined';
// Emscripten's classic-worker branch is not compatible with module workers.
// Present the worker global through its web (`window`) branch instead; it has
// the required fetch/WebAssembly APIs and avoids a blocked importScripts path.
const addedWindow = typeof globalThis.window === 'undefined';
if (addedSelf) globalThis.self = globalThis;
if (addedWindow) globalThis.window = globalThis;

let SkeletonBuilder;
try {
  const loaded = await import('./vendor/straight-skeleton/index.js?v=3.0.0');
  SkeletonBuilder = loaded.default?.SkeletonBuilder
    || loaded.SkeletonBuilder
    || globalThis.SkeletonBuilder;
  if (!SkeletonBuilder) throw new Error('Straight-skeleton geometry engine failed to load.');
  await SkeletonBuilder.init();
} finally {
  if (addedWindow) delete globalThis.window;
  if (addedSelf) delete globalThis.self;
}

export { SkeletonBuilder };
