'use strict';

// Instagram content script — extracts video/reel URLs from Instagram's
// internal data structures and reports them via 'ig-page-info' messages.

let lastSent = '';
let scanTimer = null;

function isIgVideoPage() {
  const h = location.hostname;
  const p = location.pathname;
  return (
    (h.includes('instagram.com')) &&
    (p.includes('/reel/') || p.includes('/reels/') ||
     p.includes('/p/')    || p.includes('/tv/')    ||
     p.includes('/stories/'))
  );
}

function igDecode(s) {
  return s
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003C/g, '<')
    .replace(/\\u003E/g, '>')
    .replace(/\\u0025/g, '%');
}

function looksLikeIgVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('cdninstagram.com') ||
    lower.includes('instagram.f') ||
    lower.includes('scontent') ||
    lower.includes('fbcdn.net')
  ) && (lower.includes('.mp4') || lower.includes('video'));
}

// ─── Extract from window.__additionalDataLoaded / _sharedData ─────────────────

function walkForVideos(obj, hd, sd, seen = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
  seen.add(obj);

  // Instagram key names for video URLs
  const HD_KEYS = ['video_url', 'video_hd_url', 'src'];
  const SD_KEYS = ['video_sd_url', 'video_low_url', 'src_sd'];
  const VER_KEY = 'video_versions'; // array of {type, url, width, height}

  for (const [key, val] of Object.entries(obj)) {
    if (HD_KEYS.includes(key) && looksLikeIgVideoUrl(val)) {
      if (!hd.includes(val)) hd.push(val);
    } else if (SD_KEYS.includes(key) && looksLikeIgVideoUrl(val)) {
      if (!sd.includes(val)) sd.push(val);
    } else if (key === VER_KEY && Array.isArray(val)) {
      // Sort by width descending — highest quality first
      const sorted = [...val].sort((a, b) => (b.width || 0) - (a.width || 0));
      for (const v of sorted) {
        const u = v.url || v.src;
        if (looksLikeIgVideoUrl(u)) {
          if ((v.width || 0) >= 720) { if (!hd.includes(u)) hd.push(u); }
          else                        { if (!sd.includes(u)) sd.push(u); }
        }
      }
    } else if (typeof val === 'object') {
      walkForVideos(val, hd, sd, seen);
    }
  }
}

function extractFromWindowData() {
  const hd = [], sd = [];
  try {
    const sources = [
      window.__additionalDataLoaded,
      window._sharedData,
      window.__initialData,
      window.__initialDataLoaded,
    ].filter(Boolean);

    for (const src of sources) {
      walkForVideos(typeof src === 'object' ? src : {}, hd, sd);
    }
  } catch {}
  return { hd, sd };
}

// ─── Extract from <script type="application/json"> / ld+json / relay ──────────

function extractFromScripts() {
  const hd = [], sd = [];

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';

    if (!text.includes('cdninstagram.com') && !text.includes('instagram.f') &&
        !text.includes('video_url') && !text.includes('video_versions') &&
        !text.includes('.mp4')) continue;

    // Direct key patterns
    const HD_PATTERNS = [
      /"video_url"\s*:\s*"([^"]{30,})"/g,
      /"video_hd_url"\s*:\s*"([^"]{30,})"/g,
    ];
    const SD_PATTERNS = [
      /"video_sd_url"\s*:\s*"([^"]{30,})"/g,
      /"video_low_url"\s*:\s*"([^"]{30,})"/g,
    ];

    const scan = (patterns, bucket) => {
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          const url = igDecode(m[1]);
          if (looksLikeIgVideoUrl(url) && !bucket.includes(url)) bucket.push(url);
        }
      }
    };

    scan(HD_PATTERNS, hd);
    scan(SD_PATTERNS, sd);

    // video_versions array: {"type":N,"width":W,"height":H,"url":"..."}
    const verRe = /"video_versions"\s*:\s*\[([\s\S]{0,4000}?)\]/g;
    let vm;
    while ((vm = verRe.exec(text)) !== null) {
      const block = vm[1];
      const entries = [];
      const entryRe = /\{[^}]{10,}\}/g;
      let em;
      while ((em = entryRe.exec(block)) !== null) {
        try {
          const entry = JSON.parse(em[0].replace(/\\\//g, '/'));
          if (entry.url && entry.width) entries.push(entry);
        } catch {}
      }
      entries.sort((a, b) => b.width - a.width);
      for (const e of entries) {
        const url = igDecode(e.url || '');
        if (!looksLikeIgVideoUrl(url)) continue;
        if (e.width >= 720) { if (!hd.includes(url)) hd.push(url); }
        else               { if (!sd.includes(url)) sd.push(url); }
      }
    }

    // ld+json contentUrl / embedUrl
    if (script.type === 'application/ld+json') {
      try {
        const obj = JSON.parse(text);
        for (const key of ['contentUrl','embedUrl']) {
          const url = obj?.[key];
          if (looksLikeIgVideoUrl(url) && !hd.includes(url)) hd.push(url);
        }
      } catch {}
    }
  }

  return { hd: [...new Set(hd)], sd: [...new Set(sd)] };
}

// ─── Live <video> elements ─────────────────────────────────────────────────────

function extractFromVideoElements() {
  const urls = [];
  for (const v of document.querySelectorAll('video')) {
    for (const src of [v.src, v.currentSrc]) {
      if (src && !src.startsWith('blob:') && looksLikeIgVideoUrl(src)) urls.push(src);
    }
    for (const s of v.querySelectorAll('source')) {
      if (s.src && !s.src.startsWith('blob:') && looksLikeIgVideoUrl(s.src)) urls.push(s.src);
    }
  }
  return [...new Set(urls)];
}

// ─── Poster & title ───────────────────────────────────────────────────────────

function igPosterUrl() {
  return (
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[name="thumbnail"]')?.content ||
    (() => { const p = document.querySelector('video[poster]')?.poster; return (p && !p.startsWith('blob:')) ? p : ''; })() ||
    ''
  );
}

function igTitle() {
  const raw =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[name="description"]')?.content?.slice(0, 80) ||
    document.querySelector('h1')?.textContent?.trim() ||
    document.title.replace(/ • Instagram$/i, '').replace(/ \| Instagram$/i, '') ||
    'Instagram Video';
  return raw.trim();
}

// ─── Main send ────────────────────────────────────────────────────────────────

function sendPageInfo() {
  if (!isIgVideoPage()) return;

  const fromWindow  = extractFromWindowData();
  const fromScripts = extractFromScripts();
  const fromVideo   = extractFromVideoElements();

  const hdUrls = [...new Set([...fromWindow.hd, ...fromScripts.hd])];
  const sdUrls = [...new Set([...fromWindow.sd, ...fromScripts.sd])];

  // Classify live video elements
  for (const url of fromVideo) {
    if (!hdUrls.includes(url) && !sdUrls.includes(url)) hdUrls.push(url);
  }

  const allUrls = [...new Set([...hdUrls, ...sdUrls])];
  if (!allUrls.length) return;

  const bestUrl = hdUrls[0] || sdUrls[0] || null;

  const payload = {
    type: 'ig-page-info',
    pageUrl: location.href,
    title: igTitle(),
    poster: igPosterUrl(),
    videoUrl: bestUrl,
    hdUrl: hdUrls[0] || null,
    sdUrl: sdUrls[0] || null,
    allUrls,
  };

  const serialized = JSON.stringify(payload);
  if (serialized === lastSent) return;
  lastSent = serialized;

  chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
}

function scheduleScan(delay = 300) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => { try { sendPageInfo(); } catch {} }, delay);
}

function install() {
  if (!isIgVideoPage()) return;

  if (document.body) {
    const obs = new MutationObserver(() => scheduleScan(600));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('play',           (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('loadedmetadata', (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('canplay',        (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);

  for (const delay of [300, 1200, 3000, 6000, 10000]) setTimeout(() => scheduleScan(0), delay);
  setInterval(() => scheduleScan(0), 7000);
}

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; lastSent = ''; scheduleScan(500); }
}, 700);

install();
