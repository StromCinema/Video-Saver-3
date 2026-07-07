'use strict';

(() => {
  try {
    if (typeof globalThis.__ytbdApplyLib === 'function') {
      globalThis.__ytbdApplyLib();
    }
  } catch {}

  function getJsc() {
    return typeof globalThis.jsc === 'function' ? globalThis.jsc : null;
  }

  function getDecipher() {
    return globalThis.YTBDDecipher || null;
  }

  function solveWithJsc(playerCode, kind, value) {
    const jsc = getJsc();
    if (!jsc) throw new Error('jsc solver was not available in the sandbox');

    const normalizedInput = value == null ? '' : String(value);
    const result = jsc({
      type: 'player',
      player: playerCode,
      requests: [
        {
          type: kind === 'signature' ? 'sig' : 'n',
          challenges: [normalizedInput],
        },
      ],
    });

    if (!result || result.type !== 'result' || !Array.isArray(result.responses) || !result.responses.length) {
      throw new Error('jsc returned an unexpected response');
    }

    const response = result.responses[0];
    if (response.type !== 'result' || !response.data) {
      throw new Error(response.error || `jsc failed to solve ${kind}`);
    }

    if (!Object.prototype.hasOwnProperty.call(response.data, normalizedInput)) {
      throw new Error(`jsc did not return a value for ${kind}`);
    }

    const solved = response.data[normalizedInput];
    if (solved == null) {
      throw new Error(`jsc returned null/undefined for ${kind}`);
    }

    return String(solved);
  }

  function solveWithDirectFn(playerCode, value) {
    const fn = new Function(`
      "use strict";
      ${playerCode}
      return typeof __nFn === 'function' ? __nFn : null;
    `)();

    if (typeof fn !== 'function') {
      throw new Error('__nFn is not a function after eval');
    }

    const normalizedInput = value == null ? '' : String(value);
    const result = fn(normalizedInput);

    if (result == null) {
      throw new Error('Direct fn returned null/undefined');
    }

    return String(result);
  }

  function solveWithDecipher(playerCode, kind, value) {
    const decipher = getDecipher();
    if (!decipher) throw new Error('YTBDDecipher was not available in the sandbox');

    const normalizedInput = value == null ? '' : String(value);

    if (kind === 'signature') {
      if (typeof decipher.decipherSignature !== 'function') {
        throw new Error('YTBDDecipher.decipherSignature was not available');
      }
      const result = decipher.decipherSignature(playerCode, normalizedInput);
      if (result == null) throw new Error('decipherSignature returned null/undefined');
      return String(result);
    }

    if (typeof decipher.transformN !== 'function') {
      throw new Error('YTBDDecipher.transformN was not available');
    }

    const result = decipher.transformN(playerCode, normalizedInput);
    if (result == null) throw new Error('transformN returned null/undefined');
    return String(result);
  }

  function solve(playerCode, kind, value, useDirectFn) {
    console.log('[sandbox] solve():', { kind, useDirectFn, hasDecipher: !!getDecipher(), hasJsc: !!getJsc() });

    // Direct mini-function mode is too brittle for n transforms because the
    // extracted snippet often misses nested helper objects or aliases from the
    // full player JS (errors like reading undefined helper properties such as
    // ".qz"). Prefer the full library/JSC solvers for n.
    if (useDirectFn && kind === 'signature') {
      try {
        const result = solveWithDirectFn(playerCode, value);
        return { ok: true, value: result, engine: 'direct-fn' };
      } catch (e) {
        console.warn('[sandbox] Direct fn failed, falling back to library:', e?.message || String(e));
      }
    }

    if (getDecipher()) {
      try {
        const result = solveWithDecipher(playerCode, kind, value);
        return { ok: true, value: result, engine: 'yt-decipher' };
      } catch (e) {
        console.warn('[sandbox] yt-decipher failed:', e?.message || String(e));
      }
    }

    if (getJsc()) {
      try {
        const result = solveWithJsc(playerCode, kind, value);
        return { ok: true, value: result, engine: 'jsc' };
      } catch (e) {
        return { ok: false, error: `All solvers failed. jsc: ${e?.message || String(e)}` };
      }
    }

    return { ok: false, error: 'No solver available.' };
  }

  window.addEventListener('message', (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.source !== 'ytbd-content' || data.type !== 'YTBD_DECIPHER' || !data.requestId) return;

    const payload = data.payload || {};
    const result = solve(
      payload.playerCode || '',
      payload.kind || 'signature',
      payload.value || '',
      payload.useDirectFn || false
    );

    event.source.postMessage({
      source: 'ytbd-sandbox',
      type: 'YTBD_DECIPHER_RESULT',
      requestId: data.requestId,
      ok: result.ok,
      value: result.ok ? result.value : null,
      engine: result.engine || null,
      error: result.ok ? null : (result.error || 'Unknown sandbox solver error'),
    }, '*');
  });
})();
