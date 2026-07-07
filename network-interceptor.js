'use strict';

// Injected into the PAGE world (not extension world) via chrome.scripting.
// Wraps fetch + XHR and relays video URLs back to the extension world
// via a CustomEvent on window — no inline script, no CSP violation.

(function () {
  const EVENT = '__vidsaver_url__';

  function relay(url) {
    if (!url || typeof url !== 'string') return;
    const lower = url.toLowerCase();
    if (
      !lower.includes('.mp4') && !lower.includes('.m3u8') &&
      !lower.includes('.mpd') && !lower.includes('video') &&
      !lower.includes('/manifest')
    ) return;
    if (
      lower.includes('.js') || lower.includes('.css') ||
      lower.includes('analytics') || lower.includes('tracking')
    ) return;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: url }));
  }

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { relay(typeof input === 'string' ? input : input?.url); } catch {}
    return origFetch.apply(this, arguments);
  };

  // Intercept XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { relay(typeof url === 'string' ? url : String(url)); } catch {}
    return origOpen.apply(this, arguments);
  };
})();
