'use strict';

function tryImportScripts(candidates) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      importScripts(candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to import any of: ${candidates.join(', ')}`);
}

const libPath = tryImportScripts([
  'solver/yt.solver.lib.min.js',
  'yt.solver.lib.min.js',
  'yt_solver_lib_min.js',
]);

if (typeof lib === 'object' && lib) {
  Object.assign(globalThis, lib);
}

const corePath = tryImportScripts([
  'solver/yt.solver.core.min.js',
  'yt.solver.core.min.js',
  'yt_solver_core_min.js',
]);

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type !== 'SOLVE' || !data.requestId) return;
  let payload;
  try {
    payload = jsc(data.payload);
  } catch (error) {
    payload = {
      type: 'error',
      error: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
    };
  }
  self.postMessage({
    source: 'ytbd-solver-worker',
    requestId: data.requestId,
    payload,
  });
};

self.postMessage({
  source: 'ytbd-solver-worker',
  requestId: '__ytbd_boot__',
  payload: { type: 'ready', libPath, corePath },
});
