(() => {
  function parseMaybe(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return value;
  }

  function sanitize(value, seen = new WeakSet()) {
    if (value == null) return value;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value;
    if (t === 'bigint') return Number(value);
    if (t === 'function' || t === 'symbol') return undefined;

    if (value instanceof Node || value === window) return undefined;
    if (value instanceof Date) return value.toISOString();

    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, seen)).filter((item) => item !== undefined);
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const sanitized = sanitize(entry, seen);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }

  function collectPageData() {
    return sanitize({
      playerResponse:
        parseMaybe(window.ytInitialPlayerResponse) ||
        parseMaybe(window.ytplayer?.config?.args?.raw_player_response) ||
        parseMaybe(window.ytplayer?.config?.args?.player_response) ||
        parseMaybe(window.ytplayer?.bootstrapPlayerResponse) ||
        parseMaybe(window.ytplayer?.playerResponse) ||
        parseMaybe(window.ytcfg?.data_?.PLAYER_VARS?.player_response) ||
        null,
      initialData: parseMaybe(window.ytInitialData) || null,
      ytCfg: parseMaybe(window.ytcfg?.data_) || null,
      ytPlayer: parseMaybe(window.ytplayer) || null,
    }) || {};
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.source !== 'ytbd-content') return;

    if (event.data.type === 'YTBD_GET_PAGE_DATA') {
      window.postMessage({
        source: 'ytbd-page',
        type: 'YTBD_PAGE_DATA',
        requestId: event.data.requestId,
        payload: collectPageData(),
      }, '*');
    }
  });
})();
