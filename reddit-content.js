'use strict';

// Reddit content script — detects video/audio stream URLs on comment pages
// and reports them to background.js via 'reddit-page-info' messages.

let lastSent = '';
let observer = null;
let scanTimer = null;

function isCommentsPage() {
  return location.hostname.includes('reddit.com') && location.pathname.includes('/comments/');
}

function pushUnique(list, value) {
  if (!value || typeof value !== 'string') return;
  if (value.startsWith('blob:')) return;
  if (!list.includes(value)) list.push(value);
}

function extractVideoCandidates() {
  const urls = [];
  for (const v of document.querySelectorAll('video')) {
    for (const url of [v.currentSrc, v.src, v.querySelector('source')?.src]) {
      pushUnique(urls, url);
    }
  }
  return urls;
}

function extractDirectMp4Candidates() {
  const urls = [];
  const maybeAdd = (url) => {
    if (!url || typeof url !== 'string' || url.startsWith('blob:')) return;
    if (!/^https?:/i.test(url)) return;
    const lower = url.toLowerCase();
    if (!lower.endsWith('.mp4') && !lower.includes('.mp4?')) return;
    // Accept any reddit-related domain
    const isRedditDomain =
      lower.includes('redd.it') || lower.includes('redditmedia') ||
      lower.includes('reddit.com') || lower.includes('redditstatic.com');
    if (!isRedditDomain) return;
    if (/_audio_|cmaf_audio|dash_audio|mime=audio/i.test(lower)) return;
    pushUnique(urls, url);
  };

  document.querySelectorAll('video, source').forEach((n) => { maybeAdd(n.currentSrc); maybeAdd(n.src); });
  document.querySelectorAll(
    'a[href], video[src], source[src], meta[property="og:video"], meta[property="og:video:secure_url"]'
  ).forEach((el) => maybeAdd(el.href || el.content || el.src));
  // Also check data attributes on video/shreddit-player elements
  document.querySelectorAll('[data-hls-url],[data-mpd-url],[packaged-media-json]').forEach((el) => {
    try {
      const pmj = el.getAttribute('packaged-media-json');
      if (pmj) {
        const obj = JSON.parse(pmj);
        const sources = obj?.playbackMp4s?.permutations || obj?.permutations || [];
        for (const p of sources) {
          maybeAdd(p?.source?.url);
        }
      }
    } catch {}
  });
  return urls;
}

function bestVideoUrl() {
  const urls = extractVideoCandidates();
  if (!urls.length) return null;
  return (
    urls.find((u) => /CMAF_(?!AUDIO)/i.test(u)) ||
    urls.find((u) => /DASH_(?!AUDIO)/i.test(u)) ||
    urls.find((u) => /mime=video/i.test(u)) ||
    urls.find((u) => !/_AUDIO_/i.test(u)) ||
    urls[0] || null
  );
}

function deriveAudioCandidates(videoUrl) {
  if (!videoUrl) return [];
  const out = [];
  try {
    if (/CMAF_/i.test(videoUrl)) {
      ['CMAF_AUDIO_128.mp4', 'CMAF_AUDIO_96.mp4', 'CMAF_AUDIO_64.mp4'].forEach((s) =>
        out.push(videoUrl.replace(/CMAF_[^/?#]+/i, s))
      );
    }
    if (/DASH_/i.test(videoUrl)) {
      ['DASH_AUDIO_128', 'DASH_AUDIO_96', 'DASH_AUDIO_64'].forEach((s) =>
        out.push(videoUrl.replace(/DASH_[^/?#]+/i, s))
      );
    }
    const base = videoUrl.split('?')[0];
    const dir  = base.substring(0, base.lastIndexOf('/') + 1);
    ['CMAF_AUDIO_128.mp4', 'CMAF_AUDIO_96.mp4', 'CMAF_AUDIO_64.mp4', 'DASH_AUDIO_128.mp4'].forEach((s) =>
      out.push(dir + s)
    );
  } catch {}
  return [...new Set(out)];
}

async function firstReachable(urls) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'HEAD', mode: 'cors', credentials: 'omit' });
      if (res.ok) return url;
    } catch {}
  }
  return null;
}

function posterUrl() {
  // Try Open Graph meta tag first (most reliable)
  const og = document.querySelector('meta[property="og:image"]')?.content;
  if (og && !og.includes('placeholder')) return og;

  // Try shreddit-player packaged-media-json for preview image
  const players = document.querySelectorAll('[packaged-media-json]');
  for (const el of players) {
    try {
      const obj = JSON.parse(el.getAttribute('packaged-media-json'));
      const preview = obj?.preview?.images?.[0]?.source?.url ||
                      obj?.preview?.reddit_video_preview?.fallback_url;
      if (preview) return preview.replace(/&amp;/g, '&');
    } catch {}
  }

  // Try video poster attribute
  const videoPoster = document.querySelector('video[poster]')?.poster;
  if (videoPoster && !videoPoster.startsWith('blob:')) return videoPoster;

  // Try thumbnail image near the video
  const thumb = document.querySelector(
    'img[src*="preview.redd.it"], img[src*="external-preview.redd.it"], img[src*="i.redd.it"]'
  )?.src;
  if (thumb) return thumb;

  return '';
}

async function sendPageInfo() {
  if (!isCommentsPage()) return;

  const videoUrl  = bestVideoUrl();
  const audioUrl  = await firstReachable(deriveAudioCandidates(videoUrl));
  const directMp4s = extractDirectMp4Candidates();

  const payload = {
    type: 'reddit-page-info',
    pageUrl: location.href,
    title: document.title,
    poster: posterUrl(),
    videoUrl,
    audioUrl,
    directMp4s,
  };

  const serialized = JSON.stringify(payload);
  if (serialized === lastSent) return;
  lastSent = serialized;

  chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
}

function scheduleScan(delay = 300) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => { sendPageInfo().catch(() => {}); }, delay);
}

function install() {
  if (!isCommentsPage()) return;

  if (!observer && document.body) {
    observer = new MutationObserver(() => scheduleScan(400));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  }

  document.addEventListener('play', (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  document.addEventListener('loadedmetadata', (e) => { if (e.target?.tagName === 'VIDEO') scheduleScan(100); }, true);
  setInterval(() => scheduleScan(200), 2500);
  scheduleScan(200);
}

let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastSent = '';
    scheduleScan(350);
  }
}, 600);

install();
