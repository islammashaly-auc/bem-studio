/**
 * Browser Web Worker sub-worker — runs a single rcontrib WASM call.
 *
 * Spawned as a nested module worker by browser-worker.mjs for the
 * multi-seed parallel sDA pipeline.  No COOP/COEP headers required —
 * the sub-worker only needs regular fetch access to /build/*.wasm,
 * which is available on any static-file host.
 *
 * Message in  — { args, octBuf, octName, sensorBuf }
 * Message out — { ok: true, dcBuf } | { ok: false, error }
 */

import { runRcontrib } from './browser-radiance.mjs?v=epw-loader-20260629';

self.onmessage = async (e) => {
  const { args, octBuf, octName, sensorBuf } = e.data;
  try {
    const dcBuf = await runRcontrib(args, [
      { name: octName, data: octBuf   },
      { name: 'stdin', data: sensorBuf },
    ]);
    self.postMessage({ ok: true, dcBuf }, [dcBuf]);
  } catch (err) {
    self.postMessage({ ok: false, error: err.message ?? String(err) });
  }
};
