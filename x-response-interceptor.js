'use strict';

// Injected into the PAGE (MAIN) world by background.js via chrome.scripting.
// Wraps fetch to intercept X/Twitter GraphQL responses containing video data,
// extracts MP4 variants, and relays them to x-content.js via CustomEvent.

(function () {
  if (window.__xvidsaver_installed__) return;
  window.__xvidsaver_installed__ = true;

  const VARIANT_EVENT = '__xvidsaver_variants__';
  const URL_EVENT     = '__vidsaver_url__';

  function isAudioOnly(url) {
    const lower = (url || '').toLowerCase();
    return lower.includes('.m4s') || /\/aud\/|mp4a|audio_only|\/audio\//.test(lower);
  }

  function isXVideoUrl(url) {
    const lower = (url || '').toLowerCase();
    return lower.includes('video.twimg.com') || lower.includes('ext_tw_video') ||
           lower.includes('tweet_video') || lower.includes('amp.twimg.com');
  }

  function extractVariantsFromObj(obj, found, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    if (Array.isArray(obj.variants)) {
      for (const v of obj.variants) {
        if (!v || typeof v !== 'object') continue;
        const url     = String(v.url || v.URL || '');
        const type    = String(v.content_type || v.contentType || '');
        const bitrate = parseInt(v.bitrate || v.bit_rate || 0) || 0;
        if (!url || isAudioOnly(url)) continue;
        const lower = url.toLowerCase();
        if (type.includes('mp4') || lower.includes('.mp4')) {
          found.push({ url, bitrate });
        } else if (type.includes('mpegURL') || lower.includes('.m3u8')) {
          // m3u8: only if no mp4 found later — just relay the URL
          window.dispatchEvent(new CustomEvent(URL_EVENT, { detail: url }));
        }
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) extractVariantsFromObj(item, found, depth + 1);
    } else {
      for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') extractVariantsFromObj(val, found, depth + 1);
      }
    }
  }

  function processResponseText(text) {
    if (!text || !text.includes('variants')) return;

    // Fast path: check for X video CDN domain
    if (!text.includes('video.twimg.com') && !text.includes('ext_tw_video') &&
        !text.includes('tweet_video')) return;

    let parsed;
    try { parsed = JSON.parse(text); } catch { return; }

    const found = [];
    extractVariantsFromObj(parsed, found, 0);

    if (found.length > 0) {
      // Deduplicate
      const seen = new Set();
      const uniq = found.filter(v => { if (seen.has(v.url)) return false; seen.add(v.url); return true; });
      window.dispatchEvent(new CustomEvent(VARIANT_EVENT, {
        detail: JSON.stringify(uniq)
      }));
    }

    // Also relay any direct .mp4 URLs found in the text
    const mp4Re = /https:\/\/video\.twimg\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/g;
    let m;
    while ((m = mp4Re.exec(text)) !== null) {
      const url = m[0].replace(/\\\//g, '/');
      if (!isAudioOnly(url)) {
        window.dispatchEvent(new CustomEvent(URL_EVENT, { detail: url }));
      }
    }
  }

  // Wrap fetch to read response bodies for GraphQL calls
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const response = await origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input?.url || '');
      // Only intercept X GraphQL endpoints that carry media data
      if (
        url.includes('/graphql/') ||
        url.includes('TweetDetail') ||
        url.includes('TweetResultByRestId') ||
        url.includes('UserTweets') ||
        url.includes('video.twimg.com')
      ) {
        const clone = response.clone();
        clone.text().then(text => {
          try { processResponseText(text); } catch {}
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  // Also wrap XHR for older fallback paths
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xUrl = typeof url === 'string' ? url : String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this.__xUrl || '';
    if (url.includes('/graphql/') || url.includes('TweetDetail') || isXVideoUrl(url)) {
      this.addEventListener('load', () => {
        try { processResponseText(this.responseText); } catch {}
      });
    }
    return origSend.apply(this, arguments);
  };
})();
