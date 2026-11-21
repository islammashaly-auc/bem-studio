self.onmessage = async event => {
  const msg = event.data;
  if (!msg || msg.type !== 'run') return;
  try {
    // Register the message handler before initializing the straight-skeleton
    // WASM dependency pulled in by solar-analysis. Module workers can receive
    // their first run message while a top-level-await dependency is pending.
    const { analyzeSolar } = await import('./solar-analysis.mjs?v=wall-hole-20260815');
    const result = analyzeSolar({
      btm: msg.btm,
      epw: msg.epw,
      location: msg.location,
      shadingPolygons: msg.shadingPolygons || [],
      settings: msg.settings || {},
      progress: update => self.postMessage({ type: 'progress', ...update }),
    });
    self.postMessage({ type: 'result', ok: true, result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error), stack: error?.stack || '' });
  }
};
