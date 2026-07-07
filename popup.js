'use strict';

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
  // Shared
  currentSite: null,  // 'youtube' | 'reddit' | null
  // YouTube
  videoId: null,
  videoUrl: null,
  videoTitle: null,
  videoChannel: null,
  videoDuration: null,
  isLive: false,
  isShort: false,
  selectedFormat: 'best',
  selectedQuality: '1080',
  muxWorker: null,
  muxing: false,
  // Reddit
  redditMedia: null,
  fbMedia: null,
  igMedia: null,
  genericMedia: null,
};

// ─── DOM refs ──────────────────────────────────────────────────────────────────

const $  = (id) => document.getElementById(id);
const el = {
  // shared
  siteBadge:      $('siteBadge'),
  videoInfo:      $('videoInfo'),
  noVideo:        $('noVideo'),
  noVideoMsg:     $('noVideoMsg'),
  noVideoHint:    $('noVideoHint'),
  videoThumb:     $('videoThumb'),
  videoTitle:     $('videoTitle'),
  videoChannel:   $('videoChannel'),
  videoBadges:    $('videoBadges'),
  statusBar:      $('statusBar'),
  // YouTube
  ytSettings:     $('ytSettings'),
  ytActions:      $('ytActions'),
  qualitySection: $('qualitySection'),
  btnMux:         $('btnMux'),
  muxSpinner:     $('muxSpinner'),
  muxBtnText:     $('muxBtnText'),
  muxProgress:    $('muxProgress'),
  btnAbort:       $('btnAbort'),
  btnYtOpen:      $('btnYtOpen'),
  // Reddit
  redditInfo:         $('redditInfo'),
  redditActions:      $('redditActions'),
  redditVideoUrl:     $('redditVideoUrl'),
  redditAudioUrl:     $('redditAudioUrl'),
  videoStatus:        $('videoStatus'),
  audioStatus:        $('audioStatus'),
  directMp4Section:   $('directMp4Section'),
  directMp4Select:    $('directMp4Select'),
  btnRedditMerge:     $('btnRedditMerge'),
  btnRedditVideo:     $('btnRedditVideo'),
  btnRedditAudio:     $('btnRedditAudio'),
  btnRedditDirect:    $('btnRedditDirect'),
  btnRedditRefresh:   $('btnRedditRefresh'),
  // Facebook
  fbInfo:             $('fbInfo'),
  fbActions:          $('fbActions'),
  fbHdStatus:         $('fbHdStatus'),
  fbSdStatus:         $('fbSdStatus'),
  fbHdUrlRow:         $('fbHdUrlRow'),
  fbSdUrlRow:         $('fbSdUrlRow'),
  btnFbBest:          $('btnFbBest'),
  btnFbHd:            $('btnFbHd'),
  btnFbSd:            $('btnFbSd'),
  btnFbRefresh:       $('btnFbRefresh'),
  // Instagram
  igInfo:             $('igInfo'),
  igActions:          $('igActions'),
  igHdStatus:         $('igHdStatus'),
  igSdStatus:         $('igSdStatus'),
  igHdUrlRow:         $('igHdUrlRow'),
  igSdUrlRow:         $('igSdUrlRow'),
  btnIgBest:          $('btnIgBest'),
  btnIgHd:            $('btnIgHd'),
  btnIgSd:            $('btnIgSd'),
  btnIgRefresh:       $('btnIgRefresh'),
  // Generic platforms
  genericInfo:        $('genericInfo'),
  genericActions:     $('genericActions'),
  genericHdStatus:    $('genericHdStatus'),
  genericSdStatus:    $('genericSdStatus'),
  genericHdUrlRow:    $('genericHdUrlRow'),
  genericSdUrlRow:    $('genericSdUrlRow'),
  btnGenericBest:     $('btnGenericBest'),
  btnGenericHd:       $('btnGenericHd'),
  btnGenericSd:       $('btnGenericSd'),
  btnGenericRefresh:  $('btnGenericRefresh'),
};

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  setupYouTubeControls();
  setupRedditControls();
  setupFacebookControls();
  setupInstagramControls();
  setupGenericControls();
  await detectCurrentTab();
}

// ─── Site detection ────────────────────────────────────────────────────────────

async function detectCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return showNoVideo('Open a YouTube or Reddit video page, then reopen the extension.');

  if (isYouTubeUrl(tab.url)) {
    state.currentSite = 'youtube';
    await initYouTube(tab);
  } else if (isRedditUrl(tab.url)) {
    state.currentSite = 'reddit';
    await initReddit(tab);
  } else if (isFacebookUrl(tab.url)) {
    state.currentSite = 'facebook';
    await initFacebook(tab);
  } else if (isInstagramUrl(tab.url)) {
    state.currentSite = 'instagram';
    await initInstagram(tab);
  } else {
    const gp = detectGenericPlatform(tab.url);
    if (gp) {
      state.currentSite = gp;
      await initGeneric(tab, gp);
    } else {
      showNoVideo('Open a video page on YouTube, Reddit, Facebook, Instagram, X, Vimeo, TikTok, Twitch, or Dailymotion.');
    }
  }
}

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('youtube.com') || u.hostname === 'youtu.be';
  } catch { return false; }
}

function isRedditUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('reddit.com');
  } catch { return false; }
}

function isFacebookUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('facebook.com') || u.hostname === 'fb.watch';
  } catch { return false; }
}

function isInstagramUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('instagram.com');
  } catch { return false; }
}

const GENERIC_HOSTS = {
  twitter:     ['twitter.com','x.com'],
  vimeo:       ['vimeo.com','player.vimeo.com'],
  tiktok:      ['tiktok.com','www.tiktok.com','m.tiktok.com'],
  twitch:      ['twitch.tv','www.twitch.tv','clips.twitch.tv','m.twitch.tv'],
  dailymotion: ['dailymotion.com','www.dailymotion.com'],
};

const GENERIC_NAMES = {
  twitter: 'X / Twitter', vimeo: 'Vimeo', tiktok: 'TikTok',
  twitch: 'Twitch', dailymotion: 'Dailymotion',
};

const GENERIC_BADGE_CLASS = {
  twitter: 'x', vimeo: 'vimeo', tiktok: 'tiktok', twitch: 'twitch', dailymotion: 'dm',
};

function detectGenericPlatform(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    for (const [key, hosts] of Object.entries(GENERIC_HOSTS)) {
      if (hosts.some(host => h === host || h.endsWith('.' + host))) return key;
    }
  } catch {}
  return null;
}

// ─── No-video state ────────────────────────────────────────────────────────────

function showNoVideo(msg = '', hint = '') {
  el.videoInfo.style.display    = 'none';
  el.noVideo.classList.add('visible');
  el.ytSettings.style.display   = 'none';
  el.ytActions.style.display    = 'none';
  el.redditInfo.style.display   = 'none';
  el.redditActions.style.display = 'none';
  el.fbInfo.style.display       = 'none';
  el.fbActions.style.display    = 'none';
  el.igInfo.style.display       = 'none';
  el.igActions.style.display    = 'none';
  el.genericInfo.style.display    = 'none';
  el.genericActions.style.display = 'none';
  el.siteBadge.style.display    = 'none';
  if (msg) el.noVideoMsg.textContent  = msg;
  if (hint) el.noVideoHint.textContent = hint;
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     YOUTUBE
// ─── ═══════════════════════════════════════════════════════════════════════════

function extractYTVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') && u.pathname === '/watch') {
      const v = u.searchParams.get('v');
      if (v && /^[0-9A-Za-z_-]{11}$/.test(v)) return v;
    }
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([0-9A-Za-z_-]{11})/);
    if (m) return m[2];
    if (u.hostname === 'youtu.be') {
      const v = u.pathname.slice(1, 12);
      if (/^[0-9A-Za-z_-]{11}$/.test(v)) return v;
    }
  } catch {}
  return null;
}

async function initYouTube(tab) {
  const videoId = extractYTVideoId(tab.url);
  if (!videoId) {
    setSiteBadge('yt', '▶ YouTube');
    return showNoVideo('Open a YouTube video page (/watch, /shorts, /live), then reopen the extension.',
                       'If the wrong video appears, refresh the page first.');
  }

  state.videoId  = videoId;
  state.videoUrl = tab.url;
  setSiteBadge('yt', '▶ YouTube');

  try {
    const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_INFO' });
    if (info && !info.error) {
      state.videoTitle    = info.title;
      state.videoChannel  = info.channel;
      state.videoDuration = info.duration;
      state.isLive        = info.isLive;
      state.isShort       = info.isShort;
    }
  } catch {
    state.videoTitle = tab.title?.replace(' - YouTube', '') || 'YouTube Video';
  }

  showYouTubeUI();
}

function showYouTubeUI() {
  el.noVideo.classList.remove('visible');
  el.videoInfo.style.display  = 'block';
  el.ytSettings.style.display = 'block';
  el.ytActions.style.display  = 'flex';
  el.ytActions.style.flexDirection = 'column';
  el.redditInfo.style.display    = 'none';
  el.redditActions.style.display = 'none';

  setThumb(el.videoThumb, `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg`);
  el.videoTitle.textContent   = state.videoTitle   || 'YouTube Video';
  el.videoChannel.textContent = state.videoChannel || '';
  el.videoBadges.innerHTML    = '';

  if (state.isLive)  el.videoBadges.innerHTML += '<span class="badge badge-live">LIVE</span>';
  if (state.isShort) el.videoBadges.innerHTML += '<span class="badge badge-shorts">SHORT</span>';
  if (state.videoDuration && !state.isLive) {
    el.videoBadges.innerHTML += `<span class="badge badge-duration">${fmtDur(state.videoDuration)}</span>`;
  }
}

function setupYouTubeControls() {
  document.querySelectorAll('.format-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.format-btn').forEach((n) => n.classList.remove('active'));
    btn.classList.add('active');
    state.selectedFormat = btn.dataset.format;
    el.qualitySection.style.display = state.selectedFormat === 'audio' ? 'none' : 'block';
  }));

  document.querySelectorAll('.quality-chip').forEach((chip) => chip.addEventListener('click', () => {
    document.querySelectorAll('.quality-chip').forEach((n) => n.classList.remove('active'));
    chip.classList.add('active');
    state.selectedQuality = chip.dataset.quality;
  }));

  el.btnMux.addEventListener('click', triggerMux);
  el.btnAbort.addEventListener('click', abortMux);
  el.btnYtOpen.addEventListener('click', () => {
    if (state.videoId) chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${state.videoId}` });
  });
}

// YouTube mux helpers (same logic as original popup.js, stripped of dead code)
function sanitizeFilename(name) {
  return String(name || 'download').replace(/[\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
}

function pickContainer(video, audio) {
  const v = (video?.mimeType || '').toLowerCase();
  const a = (audio?.mimeType || '').toLowerCase();
  if ((v.includes('mp4')) && (a.includes('mp4') || a.includes('m4a') || a.includes('aac'))) return 'mp4';
  if ((v.includes('webm')) && (a.includes('webm') || a.includes('opus'))) return 'webm';
  return 'mkv';
}

function guessDirectDownloadExtension(streamInfo, fallbackFormat) {
  if (streamInfo?.containerExt) return streamInfo.containerExt;
  return fallbackFormat === 'audio' ? 'm4a' : 'mp4';
}

async function triggerMux() {
  if (state.muxing || !state.videoId) return;
  showStatus('Checking the video…', 'info');

  let streamInfo;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    streamInfo = await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_STREAM_URLS',
      format: state.selectedFormat,
      quality: state.selectedQuality,
    });
  } catch {
    showStatus('Couldn\'t access the video. Refresh the page and reopen the extension.', 'error');
    return;
  }

  if (streamInfo?.error) { showStatus(streamInfo.error, 'error'); return; }
  if (!streamInfo?.videoUrl && !streamInfo?.audioUrl) {
    showStatus(streamInfo?.reason || 'No direct stream URLs were exposed.', 'error');
    return;
  }

  const directOnlySave = (state.selectedFormat === 'audio' || state.selectedFormat === 'video')
    && streamInfo?.videoUrl && !streamInfo?.audioUrl
    && !/manifest/.test(streamInfo?.strategy || '');

  if (directOnlySave) {
    const ext      = guessDirectDownloadExtension(streamInfo, state.selectedFormat);
    const filename = `${sanitizeFilename(state.videoTitle || `YouTube_${state.videoId}`)}.${ext}`;
    try {
      showStatus(`Opening save dialog for direct download…`, 'info');
      await chrome.downloads.download({ url: streamInfo.videoUrl, filename, saveAs: true, conflictAction: 'uniquify' });
      showStatus(`Saved: ${filename}`, 'success');
    } catch (err) {
      showStatus(err?.message || String(err), 'error');
    }
    return;
  }

  state.muxing = true;
  el.btnMux.disabled = true;
  el.muxSpinner.style.display = 'inline-block';
  el.muxBtnText.textContent   = 'Preparing…';
  el.btnAbort.style.display   = 'inline-block';
  el.muxProgress.style.display = 'block';
  el.muxProgress.textContent   = 'Starting remux…';

  const vMime = streamInfo?.videoMimeType || streamInfo?.mimeType || '';
  const aMime = streamInfo?.audioMimeType || streamInfo?.audioMime || '';
  const containerExt = streamInfo?.audioUrl
    ? pickContainer({ mimeType: vMime }, { mimeType: aMime })
    : (streamInfo.containerExt || 'mp4');

  state.muxWorker = new Worker(
    chrome.runtime.getURL('muxer.js') + '?v=' + chrome.runtime.getManifest().version,
    { type: 'classic' }
  );
  state.muxWorker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'progress') {
      el.muxProgress.textContent = msg.mb ? `Written: ${msg.mb} MB` : (msg.percent != null ? `${msg.percent}%` : (msg.message || 'Working…'));
    } else if (msg.type === 'file') {
      triggerBlobDownload(msg.blobUrl, msg.filename, msg.size);
    } else if (msg.type === 'done') {
      if (msg.separate) {
        el.muxProgress.textContent = `Done: ${msg.files} files saved separately`;
        showStatus('Saved video and audio as separate files', 'success');
        resetMux();
      } else {
        muxDone(msg);
      }
    } else if (msg.type === 'error') {
      muxError(msg.message);
    }
  };
  state.muxWorker.onerror = (ev) => muxError(ev.message || 'Worker error');
  state.muxWorker.postMessage({
    type: 'mux',
    videoUrl:     streamInfo.videoUrl,
    audioUrl:     streamInfo.audioUrl,
    title:        state.videoTitle || `YouTube_${state.videoId}`,
    format:       state.selectedFormat,
    containerExt,
  });

  el.muxBtnText.textContent = state.selectedFormat === 'video' ? 'Saving…' : 'Processing…';
  showStatus('Preparing your download…', 'info');
}

async function triggerBlobDownload(blobUrl, filename, size) {
  try {
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
  } catch (e) {
    showStatus(`Save failed for ${filename}: ${e?.message || String(e)}`, 'error');
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  }
}

async function muxDone({ blobUrl, filename, size }) {
  const mb = (size / 1024 / 1024).toFixed(2);
  el.muxProgress.textContent = `Done: ${mb} MB`;
  try {
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: true });
    showStatus(`Saved ${filename}`, 'success');
  } catch (err) {
    showStatus(`Download failed: ${err?.message || String(err)}`, 'error');
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    resetMux();
  }
}

function muxError(message) {
  el.muxProgress.textContent = `Error: ${message}`;
  showStatus(message, 'error');
  resetMux();
}

function abortMux() {
  if (state.muxWorker) {
    state.muxWorker.postMessage({ type: 'abort' });
    state.muxWorker.terminate();
    state.muxWorker = null;
  }
  muxError('Aborted');
}

function resetMux() {
  state.muxing = false;
  el.btnMux.disabled = false;
  el.muxSpinner.style.display = 'none';
  el.muxBtnText.textContent   = 'Download';
  el.btnAbort.style.display   = 'none';
  if (state.muxWorker) { state.muxWorker.terminate(); state.muxWorker = null; }
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDur(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     REDDIT
// ─── ═══════════════════════════════════════════════════════════════════════════

async function initReddit(tab) {
  setSiteBadge('reddit', '▶ Reddit');

  const isComments = tab.url.includes('/comments/');
  if (!isComments) {
    return showNoVideo(
      'Open a Reddit post /comments/ page and play the video for a few seconds, then reopen the extension.',
      'Only comment pages expose the video stream URLs.'
    );
  }

  await loadRedditMedia(tab.id);
}

async function loadRedditMedia(tabId) {
  const media = await chrome.runtime.sendMessage({ type: 'get-reddit-media', tabId });
  state.redditMedia = media || {};
  renderRedditUI(state.redditMedia, tabId);
}

function renderRedditUI(media, tabId) {
  const hasVideo = !!media?.videoUrl;
  const hasAudio = !!media?.audioUrl;
  const hasDirect = Array.isArray(media?.directMp4s) && media.directMp4s.length > 0;

  if (!hasVideo && !hasAudio) {
    if (hasDirect) {
      // Direct MP4 only — no split streams needed, go straight to download UI
      el.noVideo.classList.remove('visible');
      el.videoInfo.style.display = 'block';
      setThumb(el.videoThumb, media.poster);
      el.videoTitle.textContent   = cleanRedditTitle(media.title || 'Reddit Video');
      el.videoChannel.textContent = media.pageUrl ? new URL(media.pageUrl).pathname.split('/')[2] || '' : '';
      el.videoBadges.innerHTML    = '';

      el.redditInfo.style.display = 'block';
      el.ytSettings.style.display = 'none';
      el.ytActions.style.display  = 'none';

      el.videoStatus.textContent = '✗'; el.videoStatus.className = 'url-bad';
      el.audioStatus.textContent = '✗'; el.audioStatus.className = 'url-bad';
      el.redditVideoUrl.textContent = 'No split stream (direct MP4 available)';
      el.redditAudioUrl.textContent = 'No split stream (audio embedded in MP4)';

      el.directMp4Section.style.display = 'block';
      populateDirectMp4Select(media.directMp4s);

      el.redditActions.style.display = 'flex';
      el.redditActions.style.flexDirection = 'column';
      el.btnRedditMerge.style.display  = 'none';
      el.btnRedditVideo.style.display  = 'none';
      el.btnRedditAudio.style.display  = 'none';
      el.btnRedditDirect.style.display = 'inline-flex';
      el.btnRedditRefresh.style.display = 'inline-flex';
    } else {
      showNoVideo(
        'No video stream detected yet.',
        'Play the Reddit video for a few seconds, then press Refresh below.'
      );
      // Still show the Reddit action panel so user can Refresh
      el.redditActions.style.display = 'flex';
      el.redditActions.style.flexDirection = 'column';
      el.btnRedditRefresh.style.display = 'inline-flex';
      el.btnRedditMerge.style.display   = 'none';
      el.btnRedditVideo.style.display   = 'none';
      el.btnRedditAudio.style.display   = 'none';
      el.btnRedditDirect.style.display  = 'none';
    }
    return;
  }

  // Show preview
  el.noVideo.classList.remove('visible');
  el.videoInfo.style.display = 'block';
  setThumb(el.videoThumb, media.poster);
  el.videoTitle.textContent   = cleanRedditTitle(media.title || 'Reddit Video');
  el.videoChannel.textContent = media.pageUrl ? new URL(media.pageUrl).pathname.split('/')[2] || '' : '';
  el.videoBadges.innerHTML    = '';

  // Reddit info panel
  el.redditInfo.style.display = 'block';
  el.ytSettings.style.display = 'none';
  el.ytActions.style.display  = 'none';

  el.videoStatus.textContent = hasVideo ? '✓' : '✗';
  el.videoStatus.className   = hasVideo ? 'url-ok' : 'url-bad';
  el.audioStatus.textContent = hasAudio ? '✓' : '✗';
  el.audioStatus.className   = hasAudio ? 'url-ok' : 'url-bad';

  el.redditVideoUrl.textContent = media.videoUrl
    ? (media.videoUrl.length > 60 ? '…' + media.videoUrl.slice(-55) : media.videoUrl)
    : 'Not detected';
  el.redditAudioUrl.textContent = media.audioUrl
    ? (media.audioUrl.length > 60 ? '…' + media.audioUrl.slice(-55) : media.audioUrl)
    : 'Not detected (video may already include audio)';

  // Direct MP4 dropdown
  if (hasDirect) {
    el.directMp4Section.style.display = 'block';
    populateDirectMp4Select(media.directMp4s);
    el.btnRedditDirect.style.display = 'inline-flex';
  } else {
    el.directMp4Section.style.display = 'none';
    el.btnRedditDirect.style.display  = 'none';
  }

  // Action buttons
  el.redditActions.style.display  = 'flex';
  el.redditActions.style.flexDirection = 'column';
  el.btnRedditMerge.disabled      = !(hasVideo && hasAudio);
  el.btnRedditVideo.style.display = hasVideo ? 'inline-flex' : 'none';
  el.btnRedditAudio.style.display = hasAudio ? 'inline-flex' : 'none';
  el.btnRedditRefresh.style.display = 'inline-flex';
}

function populateDirectMp4Select(candidates = []) {
  const urls = Array.from(new Set(candidates.filter(Boolean)));
  el.directMp4Select.innerHTML = '';
  el.directMp4Select.disabled  = !urls.length;
  if (!urls.length) {
    el.directMp4Select.innerHTML = '<option value="">No direct MP4 detected</option>';
    return;
  }
  for (const url of urls) {
    let label = url;
    try { label = new URL(url).pathname.split('/').pop() || url; } catch {}
    const opt = document.createElement('option');
    opt.value = url;
    opt.textContent = label;
    opt.title = url;
    el.directMp4Select.appendChild(opt);
  }
}

function cleanRedditTitle(title) {
  return String(title || '').replace(/\s*\|\s*reddit\s*$/i, '').replace(/\s+/g, ' ').trim() || 'Reddit Video';
}

function redditFilename(ext = '.mp4') {
  return sanitizeFilename(cleanRedditTitle(state.redditMedia?.title || 'reddit_video')) + ext;
}

function setupRedditControls() {
  el.btnRedditRefresh.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    el.btnRedditRefresh.textContent = '↺ Scanning…';
    el.btnRedditRefresh.disabled = true;
    try {
      await new Promise(r => setTimeout(r, 800));
      await loadRedditMedia(tab.id);
    } finally {
      el.btnRedditRefresh.textContent = '↺ Refresh';
      el.btnRedditRefresh.disabled = false;
    }
  });

  el.btnRedditMerge.addEventListener('click', async () => {
    const m = state.redditMedia;
    if (!m?.videoUrl) { showStatus('Video URL missing — press Refresh first.', 'error'); return; }
    if (!m?.audioUrl) { showStatus('Audio URL missing — press Refresh first.', 'error'); return; }

    el.btnRedditMerge.disabled = true;
    showStatus('Fetching and merging streams…', 'info');
    try {
      const result = await window.RedditMerge.muxToMp4(
        m.videoUrl, m.audioUrl, cleanRedditTitle(m.title || ''),
        (msg) => showStatus(msg, 'info')
      );
      await window.RedditMerge.downloadMergedBlob(result.blob, result.filename);
      showStatus('Merge complete — download started.', 'success');
    } catch (err) {
      showStatus(err?.message || String(err), 'error');
    } finally {
      el.btnRedditMerge.disabled = false;
    }
  });

  el.btnRedditVideo.addEventListener('click', async () => {
    const url = state.redditMedia?.videoUrl;
    if (!url) { showStatus('No video URL.', 'error'); return; }
    await chrome.downloads.download({ url, filename: redditFilename('.mp4'), saveAs: true });
    showStatus('Video download started.', 'success');
  });

  el.btnRedditAudio.addEventListener('click', async () => {
    const url = state.redditMedia?.audioUrl;
    if (!url) { showStatus('No audio URL.', 'error'); return; }
    await chrome.downloads.download({ url, filename: redditFilename('.m4a'), saveAs: true });
    showStatus('Audio download started.', 'success');
  });

  el.btnRedditDirect.addEventListener('click', async () => {
    const url = el.directMp4Select?.value || state.redditMedia?.directMp4s?.[0] || '';
    if (!url) { showStatus('No direct MP4 detected.', 'error'); return; }
    await chrome.downloads.download({ url, filename: redditFilename('.mp4'), saveAs: true });
    showStatus('Direct MP4 download started.', 'success');
  });
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     FACEBOOK
// ─── ═══════════════════════════════════════════════════════════════════════════

function isFbVideoPath(url) {
  try {
    const u = new URL(url);
    return u.pathname.includes('/videos/') || u.pathname.includes('/reel/') ||
           u.pathname.includes('/watch') || /\/\d{10,}\//.test(u.pathname);
  } catch { return false; }
}

async function initFacebook(tab) {
  setSiteBadge('fb', '▶ Facebook');

  if (!isFbVideoPath(tab.url)) {
    return showNoVideo(
      'Open a Facebook video page (e.g. /videos/ or /reel/), then reopen the extension.',
      'If the video just started loading, wait a moment and reopen.'
    );
  }

  await loadFbMedia(tab.id);
}

async function loadFbMedia(tabId) {
  const media = await chrome.runtime.sendMessage({ type: 'get-fb-media', tabId });
  state.fbMedia = media || {};
  renderFbUI(state.fbMedia, tabId);
}

function renderFbUI(media, tabId) {
  const hasVideo = !!(media?.videoUrl || media?.hdUrl || media?.sdUrl);

  // Hide YouTube/Reddit UI
  el.ytSettings.style.display     = 'none';
  el.ytActions.style.display      = 'none';
  el.redditInfo.style.display     = 'none';
  el.redditActions.style.display  = 'none';

  if (!hasVideo) {
    showNoVideo(
      'No video detected yet.',
      'Play the video for a moment, then press Refresh below.'
    );
    el.fbActions.style.display = 'flex';
    el.fbActions.style.flexDirection = 'column';
    el.btnFbHd.style.display  = 'none';
    el.btnFbSd.style.display  = 'none';
    el.btnFbBest.style.display = 'none';
    el.btnFbRefresh.style.display = 'inline-flex';
    return;
  }

  // Show preview
  el.noVideo.classList.remove('visible');
  el.videoInfo.style.display = 'block';
  setThumb(el.videoThumb, media.poster);
  el.videoTitle.textContent   = cleanFbTitle(media.title || 'Facebook Video');
  el.videoChannel.textContent = media.pageUrl ? (() => {
    try { return new URL(media.pageUrl).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; }
  })() : '';
  el.videoBadges.innerHTML = '';

  // Facebook info panel
  el.fbInfo.style.display = 'block';

  const hdUrl   = media.hdUrl   || (media.allUrls || []).find(u => u.includes('_hd') || u.includes('quality_hd')) || null;
  const sdUrl   = media.sdUrl   || (media.allUrls || []).find(u => u.includes('_sd')) || null;
  const bestUrl = media.videoUrl || hdUrl || sdUrl;

  el.fbHdStatus.textContent  = hdUrl   ? '✓' : '✗';
  el.fbHdStatus.className    = hdUrl   ? 'url-ok' : 'url-bad';
  el.fbSdStatus.textContent  = sdUrl   ? '✓' : '✗';
  el.fbSdStatus.className    = sdUrl   ? 'url-ok' : 'url-bad';

  el.fbHdUrlRow.textContent  = hdUrl   ? truncUrl(hdUrl)   : 'Not detected';
  el.fbSdUrlRow.textContent  = sdUrl   ? truncUrl(sdUrl)   : 'Not detected';

  // Actions
  el.fbActions.style.display = 'flex';
  el.fbActions.style.flexDirection = 'column';
  el.btnFbBest.style.display  = bestUrl ? 'inline-flex' : 'none';
  el.btnFbHd.style.display    = hdUrl   ? 'inline-flex' : 'none';
  el.btnFbSd.style.display    = sdUrl   ? 'inline-flex' : 'none';
  el.btnFbRefresh.style.display = 'inline-flex';

  // Store resolved URLs for button handlers
  el.btnFbBest.dataset.url = bestUrl || '';
  el.btnFbHd.dataset.url   = hdUrl   || '';
  el.btnFbSd.dataset.url   = sdUrl   || '';
}

function truncUrl(url) {
  return url.length > 60 ? '…' + url.slice(-55) : url;
}

function cleanFbTitle(title) {
  return String(title || '')
    .replace(/\s*[\|–-]\s*Facebook\s*$/i, '')
    .replace(/\s*[\|–-]\s*Watch\s*$/i, '')
    .replace(/\s+/g, ' ').trim() || 'Facebook Video';
}

function fbFilename(url, suffix = '') {
  const base = sanitizeFilename(cleanFbTitle(state.fbMedia?.title || 'facebook_video'));
  return base + (suffix ? `_${suffix}` : '') + '.mp4';
}

function setupFacebookControls() {
  el.btnFbRefresh.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    el.btnFbRefresh.textContent = '↺ Scanning…';
    el.btnFbRefresh.disabled = true;
    try {
      await new Promise(r => setTimeout(r, 800));
      await loadFbMedia(tab.id);
    } finally {
      el.btnFbRefresh.textContent = '↺ Refresh';
      el.btnFbRefresh.disabled = false;
    }
  });

  async function downloadFbUrl(url, label) {
    if (!url) { showStatus(`No ${label} URL available.`, 'error'); return; }
    try {
      await chrome.downloads.download({ url, filename: fbFilename(url, label !== 'best' ? label : ''), saveAs: true });
      showStatus(`${label.toUpperCase()} download started.`, 'success');
    } catch (err) {
      showStatus(err?.message || String(err), 'error');
    }
  }

  el.btnFbBest.addEventListener('click', () => downloadFbUrl(el.btnFbBest.dataset.url, 'best'));
  el.btnFbHd.addEventListener('click',   () => downloadFbUrl(el.btnFbHd.dataset.url,   'hd'));
  el.btnFbSd.addEventListener('click',   () => downloadFbUrl(el.btnFbSd.dataset.url,   'sd'));
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     INSTAGRAM
// ─── ═══════════════════════════════════════════════════════════════════════════

function isIgVideoPath(url) {
  try {
    const u = new URL(url);
    return /\/(reel|reels|p|tv|stories)\//.test(u.pathname);
  } catch { return false; }
}

async function initInstagram(tab) {
  setSiteBadge('ig', '▶ Instagram');

  if (!isIgVideoPath(tab.url)) {
    return showNoVideo(
      'Open an Instagram reel or video post, then reopen the extension.',
      'Supports: /reel/, /p/, /tv/, /stories/'
    );
  }

  await loadIgMedia(tab.id);
}

async function loadIgMedia(tabId) {
  const media = await chrome.runtime.sendMessage({ type: 'get-ig-media', tabId });
  state.igMedia = media || {};
  renderIgUI(state.igMedia, tabId);
}

function renderIgUI(media, tabId) {
  const hasVideo = !!(media?.videoUrl || media?.hdUrl || media?.sdUrl);

  // Hide all other site panels
  el.ytSettings.style.display    = 'none';
  el.ytActions.style.display     = 'none';
  el.redditInfo.style.display    = 'none';
  el.redditActions.style.display = 'none';
  el.fbInfo.style.display        = 'none';
  el.fbActions.style.display     = 'none';

  if (!hasVideo) {
    showNoVideo(
      'No video detected yet.',
      'Play the reel or video for a moment, then press Refresh below.'
    );
    el.igActions.style.display = 'flex';
    el.igActions.style.flexDirection = 'column';
    el.btnIgBest.style.display    = 'none';
    el.btnIgHd.style.display      = 'none';
    el.btnIgSd.style.display      = 'none';
    el.btnIgRefresh.style.display = 'inline-flex';
    return;
  }

  // Preview
  el.noVideo.classList.remove('visible');
  el.videoInfo.style.display = 'block';
  setThumb(el.videoThumb, media.poster);
  el.videoTitle.textContent   = cleanIgTitle(media.title || 'Instagram Video');
  el.videoChannel.textContent = media.pageUrl ? (() => {
    try {
      const parts = new URL(media.pageUrl).pathname.split('/').filter(Boolean);
      // pathname: /username/reel/CODE or /reel/CODE — pick whichever isn't a keyword
      const skip = new Set(['reel','reels','p','tv','stories']);
      return parts.find(p => !skip.has(p)) || '';
    } catch { return ''; }
  })() : '';
  el.videoBadges.innerHTML = '<span class="badge" style="background:rgba(193,53,132,0.25);color:#e1a0cc;border:1px solid rgba(193,53,132,0.4);">Reel</span>';

  // Info panel
  el.igInfo.style.display = 'block';

  const hdUrl   = media.hdUrl || null;
  const sdUrl   = media.sdUrl || null;
  const bestUrl = media.videoUrl || hdUrl || sdUrl;

  el.igHdStatus.textContent = hdUrl ? '✓' : '✗';
  el.igHdStatus.className   = hdUrl ? 'url-ok' : 'url-bad';
  el.igSdStatus.textContent = sdUrl ? '✓' : '✗';
  el.igSdStatus.className   = sdUrl ? 'url-ok' : 'url-bad';

  el.igHdUrlRow.textContent = hdUrl ? truncUrl(hdUrl) : 'Not detected';
  el.igSdUrlRow.textContent = sdUrl ? truncUrl(sdUrl) : 'Not detected';

  // Actions
  el.igActions.style.display = 'flex';
  el.igActions.style.flexDirection = 'column';
  el.btnIgBest.style.display    = bestUrl ? 'inline-flex' : 'none';
  el.btnIgHd.style.display      = hdUrl   ? 'inline-flex' : 'none';
  el.btnIgSd.style.display      = sdUrl   ? 'inline-flex' : 'none';
  el.btnIgRefresh.style.display = 'inline-flex';

  el.btnIgBest.dataset.url = bestUrl || '';
  el.btnIgHd.dataset.url   = hdUrl   || '';
  el.btnIgSd.dataset.url   = sdUrl   || '';
}

function cleanIgTitle(title) {
  return String(title || '')
    .replace(/\s*[|–-]\s*Instagram\s*$/i, '')
    .replace(/\s+/g, ' ').trim() || 'Instagram Video';
}

function igFilename(suffix = '') {
  const base = sanitizeFilename(cleanIgTitle(state.igMedia?.title || 'instagram_video'));
  return base + (suffix ? `_${suffix}` : '') + '.mp4';
}

function setupInstagramControls() {
  el.btnIgRefresh.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    el.btnIgRefresh.textContent = '↺ Scanning…';
    el.btnIgRefresh.disabled = true;
    try {
      await new Promise(r => setTimeout(r, 800));
      await loadIgMedia(tab.id);
    } finally {
      el.btnIgRefresh.textContent = '↺ Refresh';
      el.btnIgRefresh.disabled = false;
    }
  });

  async function downloadIgUrl(url, label) {
    if (!url) { showStatus(`No ${label} URL available.`, 'error'); return; }
    try {
      await chrome.downloads.download({
        url,
        filename: igFilename(label !== 'best' ? label : ''),
        saveAs: true,
      });
      showStatus(`${label.toUpperCase()} download started.`, 'success');
    } catch (err) {
      showStatus(err?.message || String(err), 'error');
    }
  }

  el.btnIgBest.addEventListener('click', () => downloadIgUrl(el.btnIgBest.dataset.url, 'best'));
  el.btnIgHd.addEventListener('click',   () => downloadIgUrl(el.btnIgHd.dataset.url,   'hd'));
  el.btnIgSd.addEventListener('click',   () => downloadIgUrl(el.btnIgSd.dataset.url,   'sd'));
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     GENERIC PLATFORMS  (X/Twitter, Vimeo, TikTok, Twitch, Dailymotion)
// ─── ═══════════════════════════════════════════════════════════════════════════

async function initGeneric(tab, platformKey) {
  const name = GENERIC_NAMES[platformKey] || platformKey;
  const badgeClass = GENERIC_BADGE_CLASS[platformKey] || 'generic';
  setSiteBadge(badgeClass, '▶ ' + name);
  await loadGenericMedia(tab.id, platformKey);
}

async function loadGenericMedia(tabId, platformKey) {
  const media = await chrome.runtime.sendMessage({ type: 'get-generic-media', tabId });
  state.genericMedia = media || {};
  renderGenericUI(state.genericMedia, tabId, platformKey || state.currentSite);
}

function renderGenericUI(media, tabId, platformKey) {
  const hasVideo = !!(media?.videoUrl || media?.hdUrl || media?.sdUrl);
  const name = media?.platformName || GENERIC_NAMES[platformKey] || 'Video';

  // Hide all other panels
  el.ytSettings.style.display    = 'none';
  el.ytActions.style.display     = 'none';
  el.redditInfo.style.display    = 'none';
  el.redditActions.style.display = 'none';
  el.fbInfo.style.display        = 'none';
  el.fbActions.style.display     = 'none';
  el.igInfo.style.display        = 'none';
  el.igActions.style.display     = 'none';

  if (!hasVideo) {
    showNoVideo(
      `No video detected yet on ${name}.`,
      'Play the video for a moment, then press Refresh below.'
    );
    el.genericActions.style.display = 'flex';
    el.genericActions.style.flexDirection = 'column';
    el.btnGenericBest.style.display    = 'none';
    el.btnGenericHd.style.display      = 'none';
    el.btnGenericSd.style.display      = 'none';
    el.btnGenericRefresh.style.display = 'inline-flex';
    return;
  }

  // Preview
  el.noVideo.classList.remove('visible');
  el.videoInfo.style.display = 'block';
  setThumb(el.videoThumb, media.poster);
  el.videoTitle.textContent   = (media.title || name + ' Video').slice(0, 120);
  el.videoChannel.textContent = (() => {
    try { return new URL(media.pageUrl).hostname.replace(/^www\./, ''); } catch { return name; }
  })();

  // Platform badge on thumbnail
  const badgeColors = {
    twitter:     'rgba(0,0,0,0.3)',
    vimeo:       'rgba(26,183,234,0.25)',
    tiktok:      'rgba(1,1,1,0.3)',
    twitch:      'rgba(145,70,255,0.25)',
    dailymotion: 'rgba(0,102,220,0.25)',
  };
  const badgeTextColors = {
    twitter: '#aaa', vimeo: '#5dd4f0', tiktok: '#aaa',
    twitch: '#c39fff', dailymotion: '#6ab0ff',
  };
  const pk = media.platform || platformKey || '';
  el.videoBadges.innerHTML = pk
    ? `<span class="badge" style="background:${badgeColors[pk]||'rgba(255,255,255,0.1)'};color:${badgeTextColors[pk]||'#ccc'};border:1px solid rgba(255,255,255,0.12);">${name}</span>`
    : '';

  // Info panel
  el.genericInfo.style.display = 'block';

  const hdUrl   = media.hdUrl   || null;
  const sdUrl   = media.sdUrl   || null;
  const bestUrl = media.videoUrl || hdUrl || sdUrl;

  el.genericHdStatus.textContent = hdUrl ? '✓' : '✗';
  el.genericHdStatus.className   = hdUrl ? 'url-ok' : 'url-bad';
  el.genericSdStatus.textContent = sdUrl ? '✓' : '✗';
  el.genericSdStatus.className   = sdUrl ? 'url-ok' : 'url-bad';

  el.genericHdUrlRow.textContent = hdUrl ? truncUrl(hdUrl) : 'Not detected';
  el.genericSdUrlRow.textContent = sdUrl ? truncUrl(sdUrl) : 'Not detected';

  // Actions
  el.genericActions.style.display = 'flex';
  el.genericActions.style.flexDirection = 'column';
  el.btnGenericBest.style.display    = bestUrl ? 'inline-flex' : 'none';
  el.btnGenericHd.style.display      = hdUrl   ? 'inline-flex' : 'none';
  el.btnGenericSd.style.display      = sdUrl   ? 'inline-flex' : 'none';
  el.btnGenericRefresh.style.display = 'inline-flex';

  el.btnGenericBest.dataset.url = bestUrl || '';
  el.btnGenericHd.dataset.url   = hdUrl   || '';
  el.btnGenericSd.dataset.url   = sdUrl   || '';
}

function sanitizeFilename(raw) {
  return (raw || '')
    // Strip emoji and all non-ASCII characters
    .replace(/[^\x20-\x7E]/g, ' ')
    // Strip Windows/Chrome-illegal filename characters
    .replace(/[\\/:*?"<>|]/g, '')
    // Collapse multiple spaces, strip leading/trailing spaces and dots
    .replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '')
    // Truncate
    .slice(0, 80)
    .trim()
    || 'video';
}

function genericFilename(suffix = '') {
  const title = sanitizeFilename(state.genericMedia?.title || state.genericMedia?.platformName || 'video');
  return title + (suffix ? `_${suffix}` : '') + '.mp4';
}

function setupGenericControls() {
  el.btnGenericRefresh.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    el.btnGenericRefresh.textContent = '↺ Scanning…';
    el.btnGenericRefresh.disabled = true;
    try {
      // Tell content script to clear its cache and re-scan
      await chrome.tabs.sendMessage(tab.id, { type: 'rescan-generic' })
        .catch(() => {}); // content script may not be ready yet
      // Wait for it to scan and push to background
      await new Promise(r => setTimeout(r, 1200));
      await loadGenericMedia(tab.id, state.currentSite);
    } finally {
      el.btnGenericRefresh.textContent = '↺ Refresh';
      el.btnGenericRefresh.disabled = false;
    }
  });

  async function downloadGenericUrl(url, label) {
    if (!url) { showStatus(`No ${label} URL available.`, 'error'); return; }
    try {
      await chrome.downloads.download({
        url,
        filename: genericFilename(label !== 'best' ? label : ''),
        saveAs: true,
      });
      showStatus(`${label.toUpperCase()} download started.`, 'success');
    } catch (err) {
      showStatus(err?.message || String(err), 'error');
    }
  }

  el.btnGenericBest.addEventListener('click', () => downloadGenericUrl(el.btnGenericBest.dataset.url, 'best'));
  el.btnGenericHd.addEventListener('click',   () => downloadGenericUrl(el.btnGenericHd.dataset.url,   'hd'));
  el.btnGenericSd.addEventListener('click',   () => downloadGenericUrl(el.btnGenericSd.dataset.url,   'sd'));
}

// ─── ═══════════════════════════════════════════════════════════════════════════
//     Shared helpers
// ─── ═══════════════════════════════════════════════════════════════════════════

const THUMB_PLACEHOLDER = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 340 110'%3E%3Crect width='340' height='110' fill='%230a1c44' rx='12'/%3E%3Cpath d='M150 38L190 55L150 72Z' fill='%234a6fa5' opacity='0.7'/%3E%3Crect x='130' y='32' width='80' height='46' rx='8' fill='none' stroke='%234a6fa5' stroke-width='2' opacity='0.5'/%3E%3Ctext x='170' y='98' font-family='sans-serif' font-size='10' fill='%236b8fc9' text-anchor='middle' opacity='0.7'%3ENo thumbnail%3C/text%3E%3C/svg%3E`;

function setThumb(imgEl, src) {
  imgEl.onerror = () => {
    imgEl.onerror = null;
    imgEl.src = THUMB_PLACEHOLDER;
  };
  imgEl.src = src && src.trim() ? src : THUMB_PLACEHOLDER;
}

function setSiteBadge(type, text) {
  el.siteBadge.textContent  = text;
  el.siteBadge.className    = `site-badge ${type}`;
  el.siteBadge.style.display = 'inline-flex';
}

let statusTimer;
function showStatus(message, type = 'info') {
  clearTimeout(statusTimer);
  el.statusBar.textContent = message;
  el.statusBar.className   = `status-bar visible ${type}`;
  statusTimer = setTimeout(() => { el.statusBar.className = 'status-bar'; }, 6000);
}

// ─── Boot ──────────────────────────────────────────────────────────────────────

init();
