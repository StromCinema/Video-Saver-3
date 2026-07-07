'use strict';

// Facebook content script — intercepts video/reel stream URLs from FB's
// internal relay/GraphQL data and reports them via 'fb-page-info' messages.

let lastSent = '';
let scanTimer = null;

function isFbVideoPage() {
  const h = location.hostname;
  const p = location.pathname;
  return (
    (h.includes('facebook.com') || h.includes('fb.watch')) &&
    (p.includes('/videos/') || p.includes('/reel/') ||
     p.includes('/reels/')  || p.startsWith('/watch') ||
     /\/\d{10,}(\/|$)/.test(p))
  );
}

function fbDecode(s) {
  return s
    .replace(/\\\//g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\u003C/g, '<')
    .replace(/\\u003E/g, '>')
    .replace(/\\u0025/g, '%');
}

function looksLikeVideoUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!url.startsWith('https://')) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes('fbcdn.net') || lower.includes('fbcdngz.net') ||
    lower.includes('video.f')   || lower.includes('video-') ||
    lower.includes('.mp4')
  ) && (lower.includes('.mp4') || lower.includes('video'));
}

// ─── Extract from <script> relay / GraphQL blobs ─────────────────────────────

function extractFromScripts() {
  const hd = [], sd = [], other = [];

  const HD_KEYS  = ['browser_native_hd_url','playable_url_quality_hd','hd_src','video_hd_url','hd_stream_url'];
  const SD_KEYS  = ['browser_native_sd_url','playable_url','sd_src','video_sd_url','progressive_url','sd_stream_url'];
  const GEN_KEYS = ['src','video_url','stream_url'];

  for (const script of document.querySelectorAll('script')) {
    const text = script.textContent || '';
    if (!text.includes('fbcdn.net') && !text.includes('playable_url') &&
        !text.includes('browser_native') && !text.includes('video_url') &&
        !text.includes('hd_src') && !text.includes('sd_src')) continue;

    const scan = (keys, bucket) => {
      for (const key of keys) {
        const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]{20,})"', 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
          const url = fbDecode(m[1]);
          if (looksLikeVideoUrl(url) && !bucket.includes(url)) bucket.push(url);
        }
      }
    };

    scan(HD_KEYS,  hd);
    scan(SD_KEYS,  sd);
    scan(GEN_KEYS, other);

    // dash/progressive base_url arrays
    const baseRe = /"base_url"\s*:\s*"([^"]{20,})"/g;
    let m;
    while ((m = baseRe.exec(text)) !== null) {
      const url = fbDecode(m[1]);
      if (looksLikeVideoUrl(url) && !other.includes(url)) other.push(url);
    }
  }

  return { hd: [...new Set(hd)], sd: [...new Set(sd)], other: [...new Set(other)] };
}

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return ''; }
}

function extractFromWindowData() {
  const hd = [], sd = [];
  try {
    for (const src of [window.__initialData, window.__bbox, window.__FB_DATA__].filter(Boolean)) {
      const text = typeof src === 'string' ? src : safeStringify(src);
      if (!text) continue;
      const hdRe = /"(?:browser_native_hd_url|playable_url_quality_hd|hd_src)"\s*:\s*"([^"]+)"/g;
      const sdRe = /"(?:browser_native_sd_url|playable_url|sd_src|progressive_url)"\s*:\s*"([^"]+)"/g;
      let m;
      while ((m = hdRe.exec(text)) !== null) { const u = fbDecode(m[1]); if (looksLikeVideoUrl(u)) hd.push(u); }
      while ((m = sdRe.exec(text)) !== null) { const u = fbDecode(m[1]); if (looksLikeVideoUrl(u)) sd.push(u); }
    }
  } catch {}
  return { hd: [...new Set(hd)], sd: [...new Set(sd)] };
}

function extractFromVideoElements() {
  const urls = [];
  for (const v of document.querySelectorAll('video')) {
    for (const src of [v.src, v.currentSrc]) {
      if (src && !src.startsWith('blob:') && looksLikeVideoUrl(src)) urls.push(src);
    }
    for (const s of v.querySelectorAll('source')) {
      if (s.src && !s.src.startsWith('blob:') && looksLikeVideoUrl(s.src)) urls.push(s.src);
    }
  }
  return [...new Set(urls)];
}

function classifyQuality(url) {
  const lower = url.toLowerCase();
  if (lower.includes('_hd') || lower.includes('quality_hd') || lower.includes('hd_src') ||
      lower.includes('1080') || lower.includes('720')) return 'hd';
  if (lower.includes('_sd') || lower.includes('sd_src') ||
      lower.includes('480') || lower.includes('360')) return 'sd';
  const qm = url.match(/[_/](\d{3,4})[_/p]/);
  if (qm) return parseInt(qm[1]) >= 720 ? 'hd' : 'sd';
  return 'unknown';
}

function fbPosterUrl() {
  return (
    document.querySelector('meta[property="og:image"]')?.content ||
    document.querySelector('meta[name="thumbnail"]')?.content ||
    (() => { const p = document.querySelector('video[poster]')?.poster; return (p && !p.startsWith('blob:')) ? p : ''; })() ||
    ''
  );
}

function fbTitle() {
  return (
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[property="og:description"]')?.content?.slice(0, 80) ||
    document.querySelector('h1')?.textContent?.trim() ||
    document.title.replace(/ \| Facebook$/i,'').replace(/ - Facebook$/i,'').replace(/ - Watch$/i,'') ||
    'Facebook Video'
  ).trim();
}

function sendPageInfo() {
  if (!isFbVideoPage()) return;

  const fromScripts = extractFromScripts();
  const fromWindow  = extractFromWindowData();
  const fromVideo   = extractFromVideoElements();

  const hdUrls    = [...new Set([...fromScripts.hd, ...fromWindow.hd])];
  const sdUrls    = [...new Set([...fromScripts.sd, ...fromWindow.sd])];
  const otherUrls = [...new Set([...fromScripts.other, ...fromVideo])];

  for (const url of otherUrls) {
    const q = classifyQuality(url);
    if      (q === 'hd' && !hdUrls.includes(url)) hdUrls.push(url);
    else if (q === 'sd' && !sdUrls.includes(url)) sdUrls.push(url);
  }

  const allUrls = [...new Set([...hdUrls, ...sdUrls, ...otherUrls])];
  if (!allUrls.length) return;

  const bestUrl = hdUrls[0] || sdUrls[0] || otherUrls[0] || null;

  const payload = {
    type: 'fb-page-info',
    pageUrl: location.href,
    title: fbTitle(),
    poster: fbPosterUrl(),
    videoUrl: bestUrl,
    hdUrl: hdUrls[0] || null,
    sdUrl: sdUrls[0] || otherUrls.find(u => classifyQuality(u) !== 'hd') || null,
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
  if (!isFbVideoPage()) return;

  if (document.body) {
    const obs = new MutationObserver(() => scheduleScan(500));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener('play',           (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('loadedmetadata', (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('canplay',        (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);

  for (const delay of [300, 1000, 2500, 5000, 9000]) setTimeout(() => scheduleScan(0), delay);
  setInterval(() => scheduleScan(0), 6000);
}

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; lastSent = ''; scheduleScan(400); }
}, 600);

install();
