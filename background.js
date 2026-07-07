// ─── Generic platform media state (X, Vimeo, TikTok, Twitch, Dailymotion) ─────

const genericMediaByTab = new Map();

function createGenericState() {
  return { pageUrl: '', title: '', poster: '', platform: '', platformName: '', videoUrl: null, hdUrl: null, sdUrl: null, allUrls: [] };
}

// ─── Facebook media state ──────────────────────────────────────────────────────

const fbMediaByTab = new Map();

function createFbState() {
  return { pageUrl: '', title: '', poster: '', videoUrl: null, hdUrl: null, sdUrl: null, allUrls: [] };
}

// ─── Instagram media state ─────────────────────────────────────────────────────

const igMediaByTab = new Map();

function createIgState() {
  return { pageUrl: '', title: '', poster: '', videoUrl: null, hdUrl: null, sdUrl: null, allUrls: [] };
}

// ─── Reddit media state ────────────────────────────────────────────────────────

const mediaByTab = new Map();
const lastUrlByTab = new Map();

function createState() {
  return { pageUrl: '', title: '', videoUrl: null, audioUrl: null, poster: '', seen: [], directMp4s: [] };
}

function ensureTab(tabId) {
  if (!mediaByTab.has(tabId)) mediaByTab.set(tabId, createState());
  return mediaByTab.get(tabId);
}

function isRedditMediaUrl(url) {
  const lower = String(url || '').toLowerCase();
  return lower.includes('v.redd.it') || lower.includes('redd.it') || lower.includes('redditmedia');
}

function isAudioUrl(url) {
  const lower = String(url || '').toLowerCase();
  return (
    lower.includes('cmaf_audio') || lower.includes('_audio_') ||
    lower.includes('audio_128')  || lower.includes('audio_64') ||
    lower.includes('audio_96')   || lower.includes('dash_audio') ||
    lower.includes('/audio')     || lower.includes('mime=audio') ||
    lower.endsWith('.m4a')       || lower.endsWith('.mp3') || lower.endsWith('.aac')
  );
}

function isVideoUrl(url) {
  const lower = String(url || '').toLowerCase();
  return !isAudioUrl(lower) && (
    lower.includes('cmaf_') || lower.includes('dash_') ||
    lower.includes('mime=video') || lower.endsWith('.mp4') ||
    lower.includes('.mp4?')  || lower.endsWith('.webm') || lower.includes('hls')
  );
}

function classifyUrl(url) {
  if (!isRedditMediaUrl(url)) return null;
  if (isAudioUrl(url)) return 'audio';
  if (isVideoUrl(url)) return 'video';
  return null;
}

function isDirectMp4Candidate(url) {
  const lower = String(url || '').toLowerCase();
  // Accept .mp4 from any reddit-related domain (v.redd.it, redd.it, redditmedia, reddit.com, redditstatic)
  const isRedditDomain =
    lower.includes('v.redd.it') || lower.includes('redd.it') ||
    lower.includes('redditmedia') || lower.includes('reddit.com') ||
    lower.includes('redditstatic.com');
  if (!isRedditDomain) return false;
  if (!lower.endsWith('.mp4') && !lower.includes('.mp4?')) return false;
  if (isAudioUrl(lower)) return false;
  return true;
}

function pushUniqueFront(list, value, limit = 20) {
  if (!value) return;
  const idx = list.indexOf(value);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift(value);
  if (list.length > limit) list.length = limit;
}

function prefersPrimaryVideo(url) {
  const lower = String(url || '').toLowerCase();
  return lower.includes('dash_') || lower.includes('cmaf_') || lower.includes('mime=video');
}

function trackRequest(tabId, url) {
  if (tabId < 0 || !url) return;
  const media = ensureTab(tabId);
  const type = classifyUrl(url);
  if (!type) return;

  pushUniqueFront(media.seen, url, 30);
  if (isDirectMp4Candidate(url)) pushUniqueFront(media.directMp4s, url, 20);
  if (type === 'video' && (!media.videoUrl || prefersPrimaryVideo(url))) media.videoUrl = url;
  if (type === 'audio') media.audioUrl = url;
}

// ─── Reddit webRequest listener ────────────────────────────────────────────────

chrome.webRequest.onCompleted.addListener(
  (details) => { trackRequest(details.tabId, details.url); },
  { urls: ['*://v.redd.it/*', '*://*.redd.it/*', '*://*.redditmedia.com/*'] }
);

// ─── Tab / navigation lifecycle ───────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const newUrl = changeInfo.url || tab.url;
  if (!newUrl) return;
  const lastUrl = lastUrlByTab.get(tabId);
  if (lastUrl && lastUrl !== newUrl) mediaByTab.set(tabId, createState());
  lastUrlByTab.set(tabId, newUrl);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const lastUrl = lastUrlByTab.get(details.tabId);
  if (lastUrl !== details.url) {
    mediaByTab.set(details.tabId, createState());
    lastUrlByTab.set(details.tabId, details.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaByTab.delete(tabId);
  lastUrlByTab.delete(tabId);
  fbMediaByTab.delete(tabId);
  igMediaByTab.delete(tabId);
  genericMediaByTab.delete(tabId);
});

// ─── YouTube badge ─────────────────────────────────────────────────────────────

const YT_VIDEO_PATTERN        = /youtube\.com\/watch\?.*v=([0-9A-Za-z_-]{11})|youtube\.com\/shorts\/([0-9A-Za-z_-]{11})|youtube\.com\/live\/([0-9A-Za-z_-]{11})|youtu\.be\/([0-9A-Za-z_-]{11})/;
const REDDIT_COMMENTS_PATTERN = /reddit\.com\/r\/[^/]+\/comments\//;
const FB_VIDEO_PATTERN        = /facebook\.com\/.+\/videos\/|facebook\.com\/watch|facebook\.com\/reel\/|facebook\.com\/reels\/|fb\.watch\//;
const IG_VIDEO_PATTERN        = /instagram\.com\/(reel|reels|p|tv|stories)\//;
const TWITTER_PATTERN         = /(?:twitter|x)\.com\/[^/]+\/status\/\d+/;
const VIMEO_PATTERN           = /vimeo\.com\/(?:\d+|channels\/|groups\/|showcase\/)|player\.vimeo\.com/;
const TIKTOK_PATTERN          = /tiktok\.com\/@[^/]+\/video\/\d+|tiktok\.com\/t\//;
const TWITCH_PATTERN          = /twitch\.tv\/(?:videos\/\d+|clip\/|[^/]+$)|clips\.twitch\.tv\//;
const DM_PATTERN              = /dailymotion\.com\/video\/[a-z0-9]+/i;

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const url = tab.url || '';

  if (YT_VIDEO_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff0000' });
  } else if (REDDIT_COMMENTS_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff4500' });
  } else if (FB_VIDEO_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1877f2' });
  } else if (IG_VIDEO_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#c13584' });
  } else if (TWITTER_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#000000' });
  } else if (VIMEO_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1ab7ea' });
  } else if (TIKTOK_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#010101' });
  } else if (TWITCH_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#9146ff' });
  } else if (DM_PATTERN.test(url)) {
    chrome.action.setBadgeText({ tabId, text: '▶' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#0066dc' });
  } else {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

// ─── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id ?? msg.tabId ?? -1;

  // Reddit: content script reports page info
  if (msg.type === 'reddit-page-info' && tabId >= 0) {
    const media = ensureTab(tabId);
    if (media.pageUrl && msg.pageUrl && media.pageUrl !== msg.pageUrl) {
      mediaByTab.set(tabId, createState());
    }
    const m = ensureTab(tabId);
    m.pageUrl = msg.pageUrl || m.pageUrl || '';
    m.title   = msg.title   || m.title   || '';
    m.poster  = msg.poster  || m.poster  || '';
    if (msg.videoUrl && !String(msg.videoUrl).startsWith('blob:')) {
      m.videoUrl = msg.videoUrl;
      if (isDirectMp4Candidate(msg.videoUrl)) pushUniqueFront(m.directMp4s, msg.videoUrl, 20);
    }
    if (msg.audioUrl) m.audioUrl = msg.audioUrl;
    if (Array.isArray(msg.directMp4s)) {
      for (const url of msg.directMp4s) {
        if (isDirectMp4Candidate(url)) pushUniqueFront(m.directMp4s, url, 20);
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  // Reddit: popup/sidepanel requests stored media state
  if (msg.type === 'get-reddit-media') {
    const response = (tabId >= 0 && mediaByTab.has(tabId))
      ? mediaByTab.get(tabId)
      : createState();
    sendResponse(response);
    return true;
  }

  // Reddit: clear state for a tab
  if (msg.type === 'clear-reddit-media' && tabId >= 0) {
    mediaByTab.delete(tabId);
    lastUrlByTab.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  // Facebook: content script reports page info
  if (msg.type === 'fb-page-info' && tabId >= 0) {
    const prev = fbMediaByTab.get(tabId);
    if (prev?.pageUrl && msg.pageUrl && prev.pageUrl !== msg.pageUrl) {
      fbMediaByTab.delete(tabId);
    }
    const state = fbMediaByTab.get(tabId) || createFbState();
    state.pageUrl  = msg.pageUrl  || state.pageUrl  || '';
    state.title    = msg.title    || state.title    || '';
    state.poster   = msg.poster   || state.poster   || '';
    if (msg.videoUrl) state.videoUrl = msg.videoUrl;
    if (msg.hdUrl)    state.hdUrl    = msg.hdUrl;
    if (msg.sdUrl)    state.sdUrl    = msg.sdUrl;
    if (Array.isArray(msg.allUrls)) {
      for (const url of msg.allUrls) {
        if (!state.allUrls.includes(url)) state.allUrls.push(url);
      }
    }
    fbMediaByTab.set(tabId, state);
    sendResponse({ ok: true });
    return true;
  }

  // Facebook: popup requests stored media state
  if (msg.type === 'get-fb-media') {
    const response = (tabId >= 0 && fbMediaByTab.has(tabId))
      ? fbMediaByTab.get(tabId)
      : createFbState();
    sendResponse(response);
    return true;
  }

  // Facebook: clear state
  if (msg.type === 'clear-fb-media' && tabId >= 0) {
    fbMediaByTab.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  // Instagram: content script reports page info
  if (msg.type === 'ig-page-info' && tabId >= 0) {
    const prev = igMediaByTab.get(tabId);
    if (prev?.pageUrl && msg.pageUrl && prev.pageUrl !== msg.pageUrl) {
      igMediaByTab.delete(tabId);
    }
    const st = igMediaByTab.get(tabId) || createIgState();
    st.pageUrl = msg.pageUrl || st.pageUrl || '';
    st.title   = msg.title   || st.title   || '';
    st.poster  = msg.poster  || st.poster  || '';
    if (msg.videoUrl) st.videoUrl = msg.videoUrl;
    if (msg.hdUrl)    st.hdUrl    = msg.hdUrl;
    if (msg.sdUrl)    st.sdUrl    = msg.sdUrl;
    if (Array.isArray(msg.allUrls)) {
      for (const url of msg.allUrls) {
        if (!st.allUrls.includes(url)) st.allUrls.push(url);
      }
    }
    igMediaByTab.set(tabId, st);
    sendResponse({ ok: true });
    return true;
  }

  // Instagram: popup requests stored media state
  if (msg.type === 'get-ig-media') {
    const response = (tabId >= 0 && igMediaByTab.has(tabId))
      ? igMediaByTab.get(tabId)
      : createIgState();
    sendResponse(response);
    return true;
  }

  // Instagram: clear state
  if (msg.type === 'clear-ig-media' && tabId >= 0) {
    igMediaByTab.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  // X/Twitter: inject response interceptor into PAGE world
  if (msg.type === 'inject-x-response-interceptor' && tabId >= 0) {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files:  ['x-response-interceptor.js'],
      world:  'MAIN',
    }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Generic platforms: inject network interceptor into PAGE world
  if (msg.type === 'inject-network-interceptor' && tabId >= 0) {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files:  ['network-interceptor.js'],
      world:  'MAIN',
    }).catch(() => {}); // silently ignore if tab is gone or scripting not allowed
    sendResponse({ ok: true });
    return true;
  }

  // Generic platforms: content script reports page info
  if (msg.type === 'generic-page-info' && tabId >= 0) {
    const prev = genericMediaByTab.get(tabId);
    if (prev?.pageUrl && msg.pageUrl && prev.pageUrl !== msg.pageUrl) {
      genericMediaByTab.delete(tabId);
    }
    const st = genericMediaByTab.get(tabId) || createGenericState();
    st.pageUrl      = msg.pageUrl      || st.pageUrl      || '';
    st.title        = msg.title        || st.title        || '';
    st.poster       = msg.poster       || st.poster       || '';
    st.platform     = msg.platform     || st.platform     || '';
    st.platformName = msg.platformName || st.platformName || '';
    if (msg.videoUrl) st.videoUrl = msg.videoUrl;
    if (msg.hdUrl)    st.hdUrl    = msg.hdUrl;
    if (msg.sdUrl)    st.sdUrl    = msg.sdUrl;
    if (Array.isArray(msg.allUrls)) {
      for (const url of msg.allUrls) {
        if (!st.allUrls.includes(url)) st.allUrls.push(url);
      }
    }
    genericMediaByTab.set(tabId, st);
    sendResponse({ ok: true });
    return true;
  }

  // Generic platforms: popup requests stored media state
  if (msg.type === 'get-generic-media') {
    const response = (tabId >= 0 && genericMediaByTab.has(tabId))
      ? genericMediaByTab.get(tabId)
      : createGenericState();
    sendResponse(response);
    return true;
  }

  // Generic platforms: clear state
  if (msg.type === 'clear-generic-media' && tabId >= 0) {
    genericMediaByTab.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }
});

