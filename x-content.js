'use strict';

// X / Twitter dedicated content script
// X does NOT embed video URLs in the initial HTML at all — the page is a React
// SPA that loads everything via its internal GraphQL API. The only reliable
// interception points are:
//   1. XHR/fetch responses from the GraphQL endpoints that carry mediaResults
//   2. The network-interceptor.js relay for raw URLs seen in requests
//   3. <video> elements that appear after React hydration
//
// Strategy: intercept fetch responses containing "variants" in the body,
// parse the MP4 variants array, pick highest bitrate, report to background.

// ─── Is this a video-bearing page? ────────────────────────────────────────────

function isXVideoPage() {
  const p = location.pathname;
  return /\/status\/\d+/.test(p) || p.startsWith('/i/broadcasts');
}

// ─── State ────────────────────────────────────────────────────────────────────

let lastSent = '';
let scanTimer = null;

// Collected { url, bitrate } pairs — keyed by URL to deduplicate
const mp4Map = new Map();   // url -> bitrate
const m3u8Set = new Set();  // fallback only

// ─── URL helpers ──────────────────────────────────────────────────────────────

function isXVideoCdnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('video.twimg.com') ||
    lower.includes('amp.twimg.com') ||
    lower.includes('pbs.twimg.com/ext_tw_video') ||
    lower.includes('pbs.twimg.com/tweet_video')
  );
}

function isAudioOnly(url) {
  const lower = url.toLowerCase();
  return lower.includes('.m4s') || /\/aud\/|mp4a|audio_only|\/audio\//.test(lower);
}

function addVariant(url, bitrate) {
  url = (url || '').replace(/\\\//g, '/').split('#')[0];
  if (!url || isAudioOnly(url)) return;
  const lower = url.toLowerCase();
  if (lower.includes('.mp4') || lower.includes('/vid/')) {
    const existing = mp4Map.get(url);
    if (existing === undefined || bitrate > existing) mp4Map.set(url, bitrate);
  } else if (lower.includes('.m3u8')) {
    m3u8Set.add(url);
  }
}

// ─── Parse a JSON object tree for video variants ──────────────────────────────

function walkForVariants(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return;

  // video_info.variants: [{bitrate, content_type, url}]
  if (Array.isArray(obj.variants)) {
    for (const v of obj.variants) {
      if (!v || typeof v !== 'object') continue;
      const url     = v.url || v.URL || '';
      const type    = v.content_type || v.contentType || '';
      const bitrate = parseInt(v.bitrate || v.bit_rate || 0) || 0;
      if (type.includes('mp4') || url.toLowerCase().includes('.mp4')) {
        addVariant(url, bitrate);
      } else if (type.includes('mpegURL') || url.toLowerCase().includes('.m3u8')) {
        if (!isAudioOnly(url)) m3u8Set.add(url);
      }
    }
    return; // no need to go deeper once we found variants
  }

  // Walk children
  if (Array.isArray(obj)) {
    for (const item of obj) walkForVariants(item, depth + 1);
  } else {
    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') walkForVariants(val, depth + 1);
    }
  }
}

// ─── Parse raw text for variant patterns (fallback for minified JSON) ──────────

function parseTextForVariants(text) {
  if (!text || text.length < 50) return;

  // Pattern 1: full variant object with bitrate
  // {"bitrate":2176000,"content_type":"video/mp4","url":"https://..."}
  // (field order can vary)
  const VARIANT_OBJ = /\{[^{}]{10,400}\}/g;
  let m;
  VARIANT_OBJ.lastIndex = 0;
  while ((m = VARIANT_OBJ.exec(text)) !== null) {
    const s = m[0];
    if (!s.includes('content_type') && !s.includes('mp4')) continue;
    const urlM  = /"url"\s*:\s*"([^"]{20,})"/.exec(s);
    const typeM = /"content_type"\s*:\s*"([^"]*)"/.exec(s);
    const brM   = /"bitrate"\s*:\s*(\d+)/.exec(s);
    if (!urlM) continue;
    const url     = urlM[1].replace(/\\\//g, '/');
    const type    = typeM ? typeM[1] : '';
    const bitrate = brM ? parseInt(brM[1]) : 0;
    if (isAudioOnly(url)) continue;
    if (type.includes('mp4') || url.toLowerCase().includes('.mp4')) {
      addVariant(url, bitrate);
    } else if (type.includes('mpegURL') || url.toLowerCase().includes('.m3u8')) {
      m3u8Set.add(url);
    }
  }

  // Pattern 2: direct .mp4 URL from video.twimg.com
  const MP4_URL = /https:\/\/video\.twimg\.com\/[^\s"'\\]+\.mp4[^\s"'\\]*/g;
  MP4_URL.lastIndex = 0;
  while ((m = MP4_URL.exec(text)) !== null) {
    const url = m[0].replace(/\\\//g, '/');
    if (!isAudioOnly(url)) addVariant(url, 0);
  }
}

// ─── Intercept fetch responses ────────────────────────────────────────────────
// X uses GraphQL; we need to intercept RESPONSES not just requests.
// We inject into the MAIN world so we can wrap fetch and read response bodies.

let responseInterceptorActive = false;

function injectResponseInterceptor() {
  if (responseInterceptorActive) return;
  responseInterceptorActive = true;

  chrome.runtime.sendMessage(
    { type: 'inject-network-interceptor' },
    () => void chrome.runtime.lastError
  );

  // Also ask background to inject our response interceptor
  chrome.runtime.sendMessage(
    { type: 'inject-x-response-interceptor' },
    () => void chrome.runtime.lastError
  );

  // Listen for variant data sent back from the MAIN world
  window.addEventListener('__xvidsaver_variants__', (e) => {
    try {
      const variants = JSON.parse(e.detail || '[]');
      for (const v of variants) addVariant(v.url, v.bitrate || 0);
      scheduleScan(150);
    } catch {}
  });

  // Also listen for plain video URLs from the generic interceptor
  window.addEventListener('__vidsaver_url__', (e) => {
    const url = e.detail || '';
    if (!url) return;
    const lower = url.toLowerCase();
    if (isAudioOnly(url)) return;
    if (lower.includes('.mp4') && isXVideoCdnUrl(url)) {
      addVariant(url, 0);
      scheduleScan(200);
    }
  });
}

// ─── Scan <script> tags for __NEXT_DATA__ / GraphQL cached responses ──────────

function scanScripts() {
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    // Quick relevance check — X CDN domain or variant marker
    if (!text.includes('video.twimg.com') && !text.includes('variants') &&
        !text.includes('ext_tw_video')) continue;
    parseTextForVariants(text);
  }

  // window.__NEXT_DATA__ is the main SPA data store
  try {
    if (window.__NEXT_DATA__) {
      walkForVariants(
        typeof window.__NEXT_DATA__ === 'string'
          ? JSON.parse(window.__NEXT_DATA__)
          : window.__NEXT_DATA__
      );
    }
  } catch {}
}

// ─── Scan live <video> elements ───────────────────────────────────────────────

function scanVideoElements() {
  for (const v of document.querySelectorAll('video')) {
    for (const src of [v.src, v.currentSrc]) {
      if (src && !src.startsWith('blob:') && !isAudioOnly(src)) {
        const lower = src.toLowerCase();
        if (lower.includes('.mp4') && isXVideoCdnUrl(src)) addVariant(src, 0);
        else if (lower.includes('.m3u8')) m3u8Set.add(src);
      }
    }
  }
}

// ─── Build result and report ──────────────────────────────────────────────────

function getBestUrls() {
  // Sort MP4s by bitrate descending
  const sorted = [...mp4Map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url);

  if (sorted.length > 0) {
    return { hdUrl: sorted[0], sdUrl: sorted[1] || null, videoUrl: sorted[0], allUrls: sorted };
  }

  // Fall back to m3u8 only if no MP4 found
  const m3u8 = [...m3u8Set].filter(u => !isAudioOnly(u));
  if (m3u8.length > 0) {
    return { hdUrl: m3u8[0], sdUrl: null, videoUrl: m3u8[0], allUrls: m3u8 };
  }

  return null;
}

function extractTitle() {
  return (
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('[data-testid="tweetText"]')?.textContent?.slice(0, 80) ||
    document.title.replace(/ \/ X$/, '').replace(/ on X$/, '').trim() ||
    'X Video'
  );
}

function extractPoster() {
  return (
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[name="twitter:image"]')?.content ||
    document.querySelector('video[poster]')?.poster ||
    ''
  );
}

function sendPageInfo() {
  if (!isXVideoPage()) return;

  scanScripts();
  scanVideoElements();

  const best = getBestUrls();
  if (!best) return;

  const payload = {
    type: 'generic-page-info',
    platform: 'twitter',
    platformName: 'X / Twitter',
    pageUrl: location.href,
    title: extractTitle(),
    poster: extractPoster(),
    ...best,
  };

  const serialized = JSON.stringify(payload);
  if (serialized === lastSent) return;
  lastSent = serialized;
  chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
}

function scheduleScan(delay = 400) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => { try { sendPageInfo(); } catch {} }, delay);
}

// ─── SPA navigation ───────────────────────────────────────────────────────────

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastSent = '';
    mp4Map.clear();
    m3u8Set.clear();
    scheduleScan(600);
  }
}, 700);

// ─── Message handler (Refresh) ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'rescan-generic') {
    lastSent = '';
    mp4Map.clear();
    m3u8Set.clear();
    scheduleScan(50);
    sendResponse({ ok: true });
  }
  return false;
});

// ─── Install ──────────────────────────────────────────────────────────────────

function install() {
  if (!isXVideoPage()) return;

  try { injectResponseInterceptor(); } catch {}

  if (document.body) {
    const obs = new MutationObserver(() => scheduleScan(500));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('play',           e => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('loadedmetadata', e => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('canplay',        e => { if (e.target?.tagName === 'VIDEO') scheduleScan(80); },  true);

  // X loads GraphQL data async — scan repeatedly
  for (const d of [500, 1500, 3000, 6000, 10000]) setTimeout(() => scheduleScan(0), d);
  setInterval(() => scheduleScan(0), 8000);
}

install();
