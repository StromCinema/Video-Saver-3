'use strict';

// Generic video content script — covers X/Twitter, Vimeo, TikTok, Twitch, Dailymotion
// Intercepts video URLs via DOM inspection, script data mining, and network interception.
// Reports state via 'generic-page-info' messages to background.js.

// ─── Platform detection ───────────────────────────────────────────────────────

const PLATFORMS = {
  vimeo: {
    hosts: ['vimeo.com', 'player.vimeo.com'],
    name: 'Vimeo',
    badge: 'vimeo',
    color: '#1ab7ea',
    isVideoPage: (h, p) => /^\/\d+/.test(p) || h === 'player.vimeo.com' || /\/channels\/|\/groups\/|\/showcase\//.test(p),
    extractTitle: () =>
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('.clip_info-subline--title')?.textContent?.trim() ||
      document.title.replace(/ on Vimeo$/, '').trim() ||
      'Vimeo Video',
  },
  tiktok: {
    hosts: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'],
    name: 'TikTok',
    badge: 'tiktok',
    color: '#010101',
    isVideoPage: (h, p) => /\/@[^/]+\/video\/\d+/.test(p) || p.includes('/t/'),
    extractTitle: () =>
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('[class*="video-meta-title"]')?.textContent?.trim() ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.title.replace(/ \| TikTok$/, '').trim() ||
      'TikTok Video',
  },
  twitch: {
    hosts: ['twitch.tv', 'www.twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'],
    name: 'Twitch',
    badge: 'twitch',
    color: '#9146ff',
    isVideoPage: (h, p) =>
      h === 'clips.twitch.tv' ||
      p.includes('/clip/') ||
      p.includes('/videos/') ||
      (/^\/[^/]+$/.test(p) && !['/', '/directory', '/browse', '/following', '/friends'].includes(p)),
    extractTitle: () =>
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('[data-a-target="stream-title"]')?.textContent?.trim() ||
      document.querySelector('h2')?.textContent?.trim() ||
      document.title.replace(/ - Twitch$/, '').trim() ||
      'Twitch Video',
  },
  dailymotion: {
    hosts: ['dailymotion.com', 'www.dailymotion.com'],
    name: 'Dailymotion',
    badge: 'dm',
    color: '#0066dc',
    isVideoPage: (h, p) => /\/video\/[a-z0-9]+/i.test(p) || /\/embed\/video\//.test(p),
    extractTitle: () =>
      document.querySelector('meta[property="og:title"]')?.content ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.title.replace(/ - Dailymotion$/, '').trim() ||
      'Dailymotion Video',
  },
};

function detectPlatform() {
  const h = location.hostname.replace(/^www\./, '');
  for (const [key, cfg] of Object.entries(PLATFORMS)) {
    if (cfg.hosts.some(host => h === host || h.endsWith('.' + host))) {
      return { key, ...cfg };
    }
  }
  return null;
}

const platform = detectPlatform();
if (!platform) {
  // Not a supported platform — do nothing
  throw new Error('generic-content: unsupported host ' + location.hostname);
}

let lastSent = '';
let scanTimer = null;
const collectedUrls = { hd: [], sd: [], other: [] };

// ─── URL helpers ──────────────────────────────────────────────────────────────

function looksLikeVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  const lower = url.toLowerCase();
  // Reject audio-only segments: .m4s fragments, /aud/ CDN paths, audio mime types
  if (lower.includes('.m4s')) return false;
  if (/\/aud\/|\/audio\/|mp4a|audio_only/.test(lower)) return false;
  // Reject non-video file types
  if (lower.includes('.js') || lower.includes('.css') || lower.includes('.png') ||
      lower.includes('.jpg') || lower.includes('.gif') || lower.includes('.svg') ||
      lower.includes('.woff') || lower.includes('.webp') || lower.includes('.ico')) return false;
  if (lower.includes('analytics') || lower.includes('tracking') || lower.includes('beacon')) return false;
  if (url.length < 20) return false;
  // Must have a positive video signal
  return (
    lower.includes('.mp4') || lower.includes('.m3u8') || lower.includes('.mpd') ||
    lower.includes('/vid/') || lower.includes('video') || lower.includes('/manifest')
  );
}

function classifyQuality(url) {
  const lower = url.toLowerCase();
  if (lower.includes('2160') || lower.includes('4k'))  return 'hd';
  if (lower.includes('1440'))                           return 'hd';
  if (lower.includes('1080') || lower.includes('_hd') || lower.includes('-hd') ||
      lower.includes('high') || lower.includes('720'))  return 'hd';
  if (lower.includes('480') || lower.includes('360') ||
      lower.includes('240') || lower.includes('_sd') || lower.includes('-sd') ||
      lower.includes('low') || lower.includes('small')) return 'sd';
  return 'unknown';
}

function addUrl(url, force = false) {
  if (!url || typeof url !== 'string') return false;
  url = url.split('#')[0]; // strip fragments
  if (url.startsWith('blob:') || url.startsWith('data:')) return false;
  if (!force && !looksLikeVideoUrl(url)) return false;

  const all = [...collectedUrls.hd, ...collectedUrls.sd, ...collectedUrls.other];
  if (all.includes(url)) return false;

  const q = classifyQuality(url);
  if      (q === 'hd') collectedUrls.hd.push(url);
  else if (q === 'sd') collectedUrls.sd.push(url);
  else                  collectedUrls.other.push(url);
  return true;
}

// ─── Platform-specific script extractors ─────────────────────────────────────

function extractVimeo() {
  // Vimeo stores config in window.vimeo.clip_page_config or inline JSON
  try {
    const cfg =
      window?.vimeo?.clip_page_config?.clip?.encode ||
      window?.vimeo?.config?.request?.files ||
      window?.playerConfig?.request?.files;
    if (cfg) {
      const progressive = cfg.progressive || [];
      for (const item of [...progressive].sort((a, b) => (b.height || 0) - (a.height || 0))) {
        if (item.url) addUrl(item.url);
      }
    }
  } catch {}

  // Also scan scripts for Vimeo's CDN URLs
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (!text.includes('vimeocdn') && !text.includes('akamaized') && !text.includes('.mp4')) continue;
    const re = /"url"\s*:\s*"(https:\/\/[^"]*vimeocdn[^"]*\.mp4[^"]*)"/g;
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) addUrl(m[1].replace(/\\\//g, '/'));
    // HLS manifest
    const hls = /"url"\s*:\s*"(https:\/\/[^"]*\.m3u8[^"]*)"/g;
    let hm; hls.lastIndex = 0;
    while ((hm = hls.exec(text)) !== null) addUrl(hm[1].replace(/\\\//g, '/'));
  }
}

function extractTikTok() {
  // TikTok stores video in __NEXT_DATA__ or window.__INIT_PROPS__
  const sources = [window.__NEXT_DATA__, window.__INIT_PROPS__, window.__DEFAULT_SCOPE__].filter(Boolean);
  for (const src of sources) {
    try {
      const text = typeof src === 'string' ? src : JSON.stringify(src);
      // playAddr and downloadAddr are the main video URL fields
      const re = /"(?:playAddr|downloadAddr|play_addr|download_addr|url_list)"\s*:\s*(?:"([^"]{20,})"|(\[[^\]]{20,}\]))/g;
      let m; re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[1]) {
          addUrl(m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&'));
        } else if (m[2]) {
          try {
            const arr = JSON.parse(m[2].replace(/\\\//g, '/'));
            if (Array.isArray(arr)) arr.forEach(u => typeof u === 'string' && addUrl(u));
          } catch {}
        }
      }
    } catch {}
  }

  // Also scan script tags
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (!text.includes('playAddr') && !text.includes('play_addr') && !text.includes('.mp4')) continue;
    const re = /"(?:playAddr|downloadAddr|play_addr)"\s*:\s*"([^"]{20,})"/g;
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) addUrl(m[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&'));
  }
}

function extractTwitch() {
  // Twitch clips: window.__twilight_redux_state__ or meta tags
  try {
    const state = window.__twilight_redux_state__ || window.__NEXT_DATA__;
    if (state) {
      const text = typeof state === 'string' ? state : JSON.stringify(state);
      const re = /"(?:thumbnailURL|videoQualities|source|src|url)"\s*:\s*"(https:\/\/[^"]{20,})"/g;
      let m; re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const url = m[1].replace(/\\\//g, '/');
        if (url.includes('.mp4') || url.includes('.m3u8')) addUrl(url);
      }
    }
  } catch {}

  // Scan scripts for Twitch CDN urls
  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (!text.includes('twitch') && !text.includes('twitchsvc') && !text.includes('.mp4')) continue;
    const re = /"(https:\/\/[^"]{20,}(?:\.mp4|\.m3u8)[^"]*)"/g;
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) addUrl(m[1].replace(/\\\//g, '/'));
  }

  // Clip meta tags
  const clip = document.querySelector('meta[property="og:video:secure_url"]')?.content ||
               document.querySelector('meta[property="og:video"]')?.content;
  if (clip) addUrl(clip);
}

function extractDailymotion() {
  // Dailymotion exposes window.dmPlayerConfig or __DATA__
  try {
    const cfg = window.dmPlayerConfig || window.__DATA__ || window.__PLAYER_CONFIG__;
    if (cfg) {
      const text = typeof cfg === 'string' ? cfg : JSON.stringify(cfg);
      const re = /"(?:stream_url|progressive_url|hls_url|url|src)"\s*:\s*"([^"]{20,})"/g;
      let m; re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const url = m[1].replace(/\\\//g, '/');
        if (url.includes('.mp4') || url.includes('.m3u8') || url.includes('.mpd')) addUrl(url);
      }
    }
  } catch {}

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (!text.includes('dailymotion') && !text.includes('dmcdn') && !text.includes('.mp4')) continue;
    const re = /"(https:\/\/(?:[^"]*dmcdn[^"]*|[^"]*dailymotion[^"]*)(?:\.mp4|\.m3u8)[^"]*)"/g;
    let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) addUrl(m[1].replace(/\\\//g, '/'));
  }
}

// ─── Generic <video> element scan ────────────────────────────────────────────

function extractFromVideoElements() {
  let found = false;
  for (const v of document.querySelectorAll('video')) {
    for (const src of [v.src, v.currentSrc]) {
      if (src && !src.startsWith('blob:') && looksLikeVideoUrl(src)) {
        if (addUrl(src)) found = true;
      }
    }
    for (const s of v.querySelectorAll('source')) {
      if (s.src && !s.src.startsWith('blob:')) {
        if (addUrl(s.src)) found = true;
      }
    }
  }
  return found;
}

// ─── Network request interception ────────────────────────────────────────────
// Asks background.js to inject network-interceptor.js into the PAGE (MAIN)
// world via chrome.scripting — avoids CSP violations from inline scripts.
// The interceptor relays video URLs back via CustomEvents on window.

let interceptorInjected = false;

function injectNetworkInterceptor() {
  if (interceptorInjected) return;
  interceptorInjected = true;

  // Ask background to do the scripting.executeScript call (needs tabId)
  chrome.runtime.sendMessage(
    { type: 'inject-network-interceptor' },
    () => void chrome.runtime.lastError
  );

  // Listen for URLs relayed from the MAIN world interceptor
  window.addEventListener('__vidsaver_url__', (e) => {
    if (e.detail && addUrl(e.detail)) scheduleScan(200);
  });
}

// ─── Poster ───────────────────────────────────────────────────────────────────

function getTikTokPoster() {
  // TikTok blocks og:image cross-origin; dig into __NEXT_DATA__ for cover
  try {
    const nd = window.__NEXT_DATA__;
    if (nd) {
      const text = typeof nd === 'string' ? nd : JSON.stringify(nd);
      // coverLarger, cover, originCover, dynamicCover
      const keys = ['coverLarger','cover','originCover','dynamicCover','thumbnail_url'];
      for (const key of keys) {
        const m = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,})"').exec(text);
        if (m) return m[1].replace(/\\\/\//g, '/');
      }
    }
  } catch {}
  // Also try img tags with tiktokcdn
  const img = document.querySelector('img[src*="tiktokcdn"]') ||
              document.querySelector('img[src*="tiktok.com"]');
  return img?.src || '';
}

function getPoster() {
  if (platform.key === 'tiktok') {
    const p = getTikTokPoster();
    if (p) return p;
  }
  const poster = document.querySelector('video[poster]')?.poster;
  return (
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[name="twitter:image"]')?.content ||
    (poster && !poster.startsWith('blob:') ? poster : '') ||
    ''
  );
}

// ─── Main dispatch ────────────────────────────────────────────────────────────

function runExtractor() {
  try { extractFromVideoElements(); } catch {}

  switch (platform.key) {
    case 'vimeo':       try { extractVimeo();       } catch {} break;
    case 'tiktok':      try { extractTikTok();      } catch {} break;
    case 'twitch':      try { extractTwitch();      } catch {} break;
    case 'dailymotion': try { extractDailymotion(); } catch {} break;
  }
}

function sendPageInfo() {
  if (!platform.isVideoPage(location.hostname, location.pathname)) return;

  runExtractor();

  const allUrls = [...new Set([...collectedUrls.hd, ...collectedUrls.sd, ...collectedUrls.other])];
  if (!allUrls.length) return;

  const bestUrl = collectedUrls.hd[0] || collectedUrls.sd[0] || collectedUrls.other[0] || null;

  const payload = {
    type: 'generic-page-info',
    platform: platform.key,
    platformName: platform.name,
    pageUrl: location.href,
    title: platform.extractTitle(),
    poster: getPoster(),
    videoUrl: bestUrl,
    hdUrl: collectedUrls.hd[0] || null,
    sdUrl: collectedUrls.sd[0] || collectedUrls.other[0] || null,
    allUrls,
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

// ─── SPA navigation watch ─────────────────────────────────────────────────────

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastSent = '';
    collectedUrls.hd.length = 0;
    collectedUrls.sd.length = 0;
    collectedUrls.other.length = 0;
    scheduleScan(500);
  }
}, 700);

// ─── Install ──────────────────────────────────────────────────────────────────

function install() {
  if (!platform.isVideoPage(location.hostname, location.pathname)) return;

  try { injectNetworkInterceptor(); } catch {}

  if (document.body) {
    const obs = new MutationObserver(() => scheduleScan(600));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('play',           e => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('loadedmetadata', e => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('canplay',        e => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);

  // Staggered scans — all these platforms load data asynchronously
  for (const d of [300, 1000, 2500, 5000, 9000]) setTimeout(() => scheduleScan(0), d);
  setInterval(() => scheduleScan(0), 8000);
}

install();

// ─── Message listener (for Refresh from popup) ────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'rescan-generic') {
    // Clear stale state so fresh URLs are reported
    lastSent = '';
    collectedUrls.hd.length = 0;
    collectedUrls.sd.length = 0;
    collectedUrls.other.length = 0;
    scheduleScan(50);
    sendResponse({ ok: true });
  }
  return false;
});
