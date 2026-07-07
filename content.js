'use strict';

/**
 * Content script injected into YouTube pages.
 * Reads metadata and stream info directly from the page context so the
 * extension can work without yt-dlp.
 *
 * Stream extraction order:
 *  1. window/page globals
 *  2. inline script blobs
 *  3. Innertube player API fallback using page config
 *  4. Plan B JS decipher for signatureCipher and n
 */

const PLAYER_CACHE = new Map();
const PAGE_BRIDGE_ID = 'ytbd-page-bridge';
const SANDBOX_FRAME_ID = 'ytbd-sandbox-frame';
const SOLVER_REQUEST_TIMEOUT_MS = 12000;
let sandboxFramePromise = null;
let solverRequestSeq = 0;
const solverPending = new Map();
let solverWorkerPromise = null;
let workerRequestSeq = 0;
const workerPending = new Map();

function hasExtensionRuntime() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

const INNERTUBE_CLIENT_PROFILES = [
  { name: 'ANDROID_VR', version: '1.60.19', platform: 'MOBILE', osName: 'Android', osVersion: '13', userAgent: 'com.google.android.apps.youtube.vr/1.60.19 (Linux; U; Android 13) gzip' },
  { name: 'ANDROID', version: '19.44.38', platform: 'MOBILE', osName: 'Android', osVersion: '13', userAgent: 'com.google.android.youtube/19.44.38 (Linux; U; Android 13) gzip' },
  { name: 'MWEB', version: '2.20250312.00.00', platform: 'MOBILE', osName: 'Android', osVersion: '13', userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36' },
  { name: 'WEB', version: null, platform: 'DESKTOP', osName: 'Windows', osVersion: '10.0', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36' },
  { name: 'WEB_SAFARI', version: '2.20250312.00.00', platform: 'DESKTOP', osName: 'Macintosh', osVersion: '10_15_7', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' },
];

function findFirstKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const value of Object.values(obj)) {
    const result = findFirstKey(value, key);
    if (result !== null) return result;
  }
  return null;
}

function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.simpleText) return obj.simpleText;
  if (Array.isArray(obj.runs)) return obj.runs.map((r) => r.text || '').join('');
  return '';
}

function getVideoIdFromLocation() {
  try {
    const pathMatch = window.location.pathname.match(/^\/(shorts|live|embed)\/([0-9A-Za-z_-]{11})/);
    if (pathMatch) return pathMatch[2];
    if (window.location.pathname === '/watch') {
      const v = new URL(window.location.href).searchParams.get('v');
      if (v && /^[0-9A-Za-z_-]{11}$/.test(v)) return v;
    }
  } catch {}
  return null;
}

function extractAssignedJson(source, variableName) {
  const idx = source.indexOf(variableName);
  if (idx === -1) return null;

  const eqIdx = source.indexOf('=', idx);
  if (eqIdx === -1) return null;

  const start = source.indexOf('{', eqIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonText = source.slice(start, i + 1);
        try {
          return JSON.parse(jsonText);
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function readFallbackScriptData() {
  const result = {
    playerResponse: null,
    initialData: null,
    ytCfg: null,
    ytPlayer: null,
  };

  try {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!result.playerResponse && text.includes('ytInitialPlayerResponse')) {
        result.playerResponse = extractAssignedJson(text, 'ytInitialPlayerResponse');
      }
      if (!result.initialData && text.includes('ytInitialData')) {
        result.initialData = extractAssignedJson(text, 'ytInitialData');
      }
      if (!result.ytPlayer && text.includes('ytplayer')) {
        result.ytPlayer = extractAssignedJson(text, 'ytplayer');
      }
      if (!result.ytCfg && text.includes('ytcfg.set(')) {
        const match = text.match(/ytcfg\.set\((\{[\s\S]*?\})\);?/);
        if (match) {
          try {
            result.ytCfg = JSON.parse(match[1]);
          } catch {}
        }
      }
      if (result.playerResponse && result.initialData && result.ytCfg) break;
    }
  } catch {}

  return result;
}

function injectPageBridge() {
  if (!hasExtensionRuntime()) return;
  if (document.getElementById(PAGE_BRIDGE_ID)) return;

  const script = document.createElement('script');
  script.id = PAGE_BRIDGE_ID;
  script.src = chrome.runtime.getURL('page-bridge.js');
  script.async = false;
  (document.documentElement || document.head || document.body).appendChild(script);
}

function readPageContextData() {
  return new Promise((resolve) => {
    injectPageBridge();

    const requestId = `yt-browser-downloader:${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve(payload || {});
    };

    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'ytbd-page') return;
      if (data.type !== 'YTBD_PAGE_DATA') return;
      if (data.requestId !== requestId) return;
      finish(data.payload);
    };

    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'ytbd-content',
      type: 'YTBD_GET_PAGE_DATA',
      requestId,
    }, '*');

    setTimeout(() => finish({}), 500);
  });
}

function getSandboxFrame() {
  if (!hasExtensionRuntime()) {
    return Promise.reject(new Error('Extension runtime is not available'));
  }
  if (sandboxFramePromise) return sandboxFramePromise;

  sandboxFramePromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(SANDBOX_FRAME_ID);
    if (existing && existing.contentWindow) {
      resolve(existing);
      return;
    }

    const frame = document.createElement('iframe');
    frame.id = SANDBOX_FRAME_ID;
    frame.src = chrome.runtime.getURL('sandbox.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = [
      'display:none',
      'width:0',
      'height:0',
      'border:0',
      'position:fixed',
      'left:-9999px',
      'top:-9999px',
      'pointer-events:none',
      'opacity:0',
    ].join(';');

    const cleanup = () => {
      frame.removeEventListener('load', onLoad);
      frame.removeEventListener('error', onError);
    };

    const onLoad = () => {
      cleanup();
      resolve(frame);
    };

    const onError = () => {
      cleanup();
      sandboxFramePromise = null;
      try { frame.remove(); } catch {}
      reject(new Error('Sandbox iframe failed to load'));
    };

    frame.addEventListener('load', onLoad, { once: true });
    frame.addEventListener('error', onError, { once: true });
    (document.documentElement || document.head || document.body).appendChild(frame);
  });

  return sandboxFramePromise;
}


function getSolverWorker() {
  if (!hasExtensionRuntime()) {
    return Promise.reject(new Error('Extension runtime is not available'));
  }
  if (solverWorkerPromise) return solverWorkerPromise;

  solverWorkerPromise = new Promise((resolve, reject) => {
    try {
      const worker = new Worker(chrome.runtime.getURL('solver-worker.js'));

      const onReadyError = (event) => {
        solverWorkerPromise = null;
        reject(new Error(event?.message || 'Solver worker failed to load'));
      };

      const onMessage = (event) => {
        const data = event.data || {};
        if (data.source !== 'ytbd-solver-worker' || !data.requestId) return;

        if (data.requestId === '__ytbd_boot__') {
          worker.removeEventListener('error', onReadyError);
          resolve(worker);
          return;
        }

        const pending = workerPending.get(data.requestId);
        if (!pending) return;

        clearTimeout(pending.timeoutId);
        workerPending.delete(data.requestId);

        const payload = data.payload || {};
        if (payload.type === 'result' && Array.isArray(payload.responses) && payload.responses.length) {
          const response = payload.responses[0];
          if (response.type === 'result' && response.data && Object.prototype.hasOwnProperty.call(response.data, pending.challenge)) {
            pending.resolve({
              ok: true,
              value: response.data[pending.challenge],
              engine: 'jsc',
            });
            return;
          }
          pending.resolve({
            ok: false,
            error: response?.error || 'Solver worker returned no usable value.',
            engine: 'jsc',
          });
          return;
        }

        pending.resolve({
          ok: false,
          error: payload.error || 'Solver worker returned an unexpected payload.',
          engine: 'jsc',
        });
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onReadyError, { once: true });

      worker.postMessage({
        type: 'SOLVE',
        requestId: '__ytbd_boot__',
        payload: {
          type: 'player',
          player: 'function noop(){}',
          requests: [{ type: 'n', challenges: ['x'] }],
        },
      });
    } catch (error) {
      solverWorkerPromise = null;
      reject(error);
    }
  });

  return solverWorkerPromise;
}

function runPlanInWorker({ playerCode, kind, arg }) {
  return new Promise(async (resolve) => {
    const challenge = arg == null ? '' : String(arg);
    const requestId = `ytbd-worker:${++workerRequestSeq}:${Math.random().toString(36).slice(2)}`;
    const timeoutId = setTimeout(() => {
      workerPending.delete(requestId);
      resolve({ ok: false, error: 'Solver worker timeout', engine: 'jsc' });
    }, SOLVER_REQUEST_TIMEOUT_MS);

    workerPending.set(requestId, { resolve, timeoutId, challenge });

    try {
      const worker = await getSolverWorker();
      worker.postMessage({
        type: 'SOLVE',
        requestId,
        payload: {
          type: 'player',
          player: playerCode == null ? '' : String(playerCode),
          requests: [
            {
              type: kind === 'signature' ? 'sig' : 'n',
              challenges: [challenge],
            },
          ],
        },
      });
    } catch (error) {
      clearTimeout(timeoutId);
      workerPending.delete(requestId);
      resolve({ ok: false, error: error?.message || String(error), engine: 'jsc' });
    }
  });
}

window.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.source !== 'ytbd-sandbox' || data.type !== 'YTBD_DECIPHER_RESULT' || !data.requestId) return;

  const pending = solverPending.get(data.requestId);
  if (!pending) return;

  clearTimeout(pending.timeoutId);
  solverPending.delete(data.requestId);
  pending.resolve(data.ok
    ? { ok: true, value: data.value, engine: data.engine || null }
    : { ok: false, error: data.error || 'Unknown sandbox solver error', engine: data.engine || null });
});

// ── n/sig solver — delegates to background service worker (no CSP restrictions) ──

function runPlanInSandbox({ playerCode, kind, arg, useDirectFn = false }) {
  if (kind === 'n') {
    return runPlanInWorker({ playerCode, kind, arg });
  }
  return new Promise(async (resolve) => {
    const requestId = `ytbd-decipher:${++solverRequestSeq}:${Math.random().toString(36).slice(2)}`;

    const timeoutId = setTimeout(() => {
      solverPending.delete(requestId);
      resolve({ ok: false, error: 'Sandbox solver timeout' });
    }, SOLVER_REQUEST_TIMEOUT_MS);

    solverPending.set(requestId, { resolve, timeoutId });

    try {
      const frame = await getSandboxFrame();
      if (!frame?.contentWindow) {
        clearTimeout(timeoutId);
        solverPending.delete(requestId);
        resolve({ ok: false, error: 'Sandbox iframe is not available' });
        return;
      }

      frame.contentWindow.postMessage({
        source: 'ytbd-content',
        type: 'YTBD_DECIPHER',
        requestId,
        payload: {
          playerCode,
          kind,
          value: arg,
          useDirectFn,
        },
      }, '*');
    } catch (error) {
      clearTimeout(timeoutId);
      solverPending.delete(requestId);
      resolve({ ok: false, error: error?.message || String(error) });
    }
  });
}


async function getPageData() {
  const pageData = await readPageContextData();
  const fallback = readFallbackScriptData();
  return {
    playerResponse: pageData.playerResponse || fallback.playerResponse || null,
    initialData: pageData.initialData || fallback.initialData || null,
    ytCfg: pageData.ytCfg || fallback.ytCfg || null,
    ytPlayer: pageData.ytPlayer || fallback.ytPlayer || null,
  };
}

async function getVideoInfo() {
  const data = await getPageData();
  const info = {
    title: null,
    channel: null,
    duration: null,
    isLive: false,
    isShort: false,
    videoId: null,
    viewCount: null,
    uploadDate: null,
  };

  const pr = data.playerResponse;
  const details = pr?.videoDetails;
  if (details) {
    info.videoId = details.videoId || null;
    info.title = details.title || null;
    info.channel = details.author || null;
    info.duration = Number.parseInt(details.lengthSeconds, 10) || null;
    info.isLive = details.isLive === true;
    info.isShort = details.isShortsEligible === true;
    info.viewCount = Number.parseInt(details.viewCount, 10) || null;
  }

  const micro = pr?.microformat?.playerMicroformatRenderer;
  if (micro) {
    info.uploadDate = micro.publishDate || micro.uploadDate || null;
    info.isLive = info.isLive || micro.liveBroadcastDetails?.isLiveNow === true;
  }

  if (!info.title && data.initialData) {
    const vpir = findFirstKey(data.initialData, 'videoPrimaryInfoRenderer');
    if (vpir) info.title = extractText(vpir.title);

    const vsir = findFirstKey(data.initialData, 'videoSecondaryInfoRenderer');
    if (vsir) info.channel = extractText(vsir?.owner?.videoOwnerRenderer?.title);
  }

  if (!info.title) info.title = document.title?.replace(' - YouTube', '') || '';
  if (!info.channel) {
    const channelEl = document.querySelector('ytd-channel-name yt-formatted-string, #channel-name .ytd-channel-name');
    if (channelEl) info.channel = channelEl.textContent.trim();
  }

  if (!info.duration) {
    const timeEl = document.querySelector('.ytp-time-duration');
    if (timeEl) {
      const parts = timeEl.textContent.split(':').map(Number);
      if (parts.length === 2) info.duration = parts[0] * 60 + parts[1];
      else if (parts.length === 3) info.duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }

  if (!info.videoId) info.videoId = getVideoIdFromLocation();
  if (window.location.pathname.startsWith('/shorts/')) info.isShort = true;
  return info;
}

function getInnertubeConfig(data) {
  const cfg = data?.ytCfg || {};
  const playerCfg = data?.ytPlayer?.config || {};
  const playerArgs = playerCfg?.args || {};

  const apiKey = cfg.INNERTUBE_API_KEY || cfg.API_KEY || playerCfg?.innertubeApiKey || null;
  const clientName = cfg.INNERTUBE_CLIENT_NAME || playerCfg?.innertubeContextClientName || 'WEB';
  const clientVersion = cfg.INNERTUBE_CLIENT_VERSION || cfg.CLIENT_VERSION || playerCfg?.innertubeClientVersion || playerArgs?.cver || null;
  const hl = cfg.HL || document.documentElement.lang || 'en';
  const gl = cfg.GL || 'US';
  const visitorData = cfg.VISITOR_DATA || null;
  const sts = cfg.STS || playerCfg?.sts || null;

  return { apiKey, clientName, clientVersion, hl, gl, visitorData, sts };
}

function buildInnertubeClientConfig(data, profile = null) {
  const cfg = getInnertubeConfig(data);
  const selected = profile || { name: cfg.clientName || 'WEB', version: cfg.clientVersion, platform: 'DESKTOP', osName: 'Windows', osVersion: '10.0', userAgent: null };
  return {
    apiKey: cfg.apiKey,
    clientName: selected.name || cfg.clientName || 'WEB',
    clientVersion: selected.version || cfg.clientVersion,
    hl: cfg.hl,
    gl: cfg.gl,
    visitorData: cfg.visitorData,
    sts: cfg.sts,
    userAgent: selected.userAgent || null,
    platform: selected.platform || 'DESKTOP',
    osName: selected.osName || null,
    osVersion: selected.osVersion || null,
  };
}

function getPreferredInnertubeProfiles(data) {
  const cfg = getInnertubeConfig(data);
  const preferred = [];
  const seen = new Set();

  const pushProfile = (profile) => {
    if (!profile?.name || seen.has(profile.name)) return;
    seen.add(profile.name);
    preferred.push(profile);
  };

  for (const profile of INNERTUBE_CLIENT_PROFILES) {
    pushProfile({ ...profile, version: profile.version || cfg.clientVersion || '2.20250312.00.00' });
  }

  pushProfile({
    name: cfg.clientName || 'WEB',
    version: cfg.clientVersion || '2.20250312.00.00',
    platform: 'DESKTOP',
    osName: 'Windows',
    osVersion: '10.0',
    userAgent: null,
  });

  return preferred;
}

async function fetchPlayerResponseFromInnertube(data, profile = null) {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return { playerResponse: null, reason: 'Could not determine the current video ID.', clientName: profile?.name || null };

  const cfg = buildInnertubeClientConfig(data, profile);
  if (!cfg.apiKey || !cfg.clientVersion) {
    return { playerResponse: null, reason: 'Missing YouTube API config on the page for player fallback.', clientName: cfg.clientName };
  }

  const body = {
    context: {
      client: {
        clientName: cfg.clientName,
        clientVersion: cfg.clientVersion,
        hl: cfg.hl,
        gl: cfg.gl,
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
        platform: cfg.platform,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    videoId,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        signatureTimestamp: cfg.sts || undefined,
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };

  if (cfg.osName) body.context.client.osName = cfg.osName;
  if (cfg.osVersion) body.context.client.osVersion = cfg.osVersion;
  if (cfg.visitorData) body.context.client.visitorData = cfg.visitorData;

  const headers = {
    'content-type': 'application/json',
    'x-youtube-client-name': String(cfg.clientName),
    'x-youtube-client-version': String(cfg.clientVersion),
  };
  if (cfg.userAgent) headers['user-agent'] = cfg.userAgent;

  try {
    const response = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(cfg.apiKey)}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return { playerResponse: null, reason: `${cfg.clientName} player request failed with HTTP ${response.status}.`, clientName: cfg.clientName };
    }

    const playerResponse = await response.json();
    return {
      playerResponse,
      clientName: cfg.clientName,
      reason: playerResponse?.streamingData
        ? `Loaded streaming data from the ${cfg.clientName} player API fallback.`
        : `${cfg.clientName} player API fallback returned no streaming data.`,
    };
  } catch (error) {
    return { playerResponse: null, reason: `${cfg.clientName} player API fallback failed: ${error?.message || String(error)}`, clientName: cfg.clientName };
  }
}

function getPlayerUrlFromData(data) {
  const fromCfg =
    data?.ytCfg?.PLAYER_JS_URL ||
    data?.ytCfg?.WEB_PLAYER_CONTEXT_CONFIGS?._DEFAULT?.jsUrl ||
    data?.ytCfg?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH?.jsUrl ||
    data?.ytPlayer?.web_player_context_config?.jsUrl ||
    data?.ytPlayer?.config?.assets?.js ||
    data?.playerResponse?.assets?.js ||
    null;

  if (fromCfg) {
    try { return new URL(fromCfg, location.origin).toString(); } catch {}
  }

  const script = Array.from(document.scripts).find((node) => /\/s\/player\/.+\/base\.js/.test(node.src || ''));
  if (script?.src) return script.src;
  return null;
}

function findMatchingBracket(source, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let regexAllowed = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    const prev = source[i - 1];

    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '/' && prev !== '\\' && regexAllowed) {
      quote = '/';
      continue;
    }

    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }

    regexAllowed = /[({[;,?:=!]$/.test(ch) || /\s/.test(ch);
  }

  return -1;
}

function extractFunctionByName(source, name) {
  const escaped = name.replace(/[$]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`, 'm'),
    new RegExp(`${escaped}\\s*=\\s*function\\s*\\(([^)]*)\\)\\s*\\{`, 'm'),
    new RegExp(`function\\s+${escaped}\\s*\\(([^)]*)\\)\\s*\\{`, 'm'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const braceStart = source.indexOf('{', match.index + match[0].length - 1);
    if (braceStart === -1) continue;
    const braceEnd = findMatchingBracket(source, braceStart, '{', '}');
    if (braceEnd === -1) continue;
    const args = match[1] || 'a';
    return `function(${args})${source.slice(braceStart, braceEnd + 1)}`;
  }
  return null;
}

function extractObjectByName(source, name) {
  const escaped = name.replace(/[$]/g, '\\$&');
  const patterns = [
    new RegExp(`(?:var|let|const)\\s+${escaped}\\s*=\\s*\\{`, 'm'),
    new RegExp(`${escaped}\\s*=\\s*\\{`, 'm'),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const braceStart = source.indexOf('{', match.index + match[0].length - 1);
    if (braceStart === -1) continue;
    const braceEnd = findMatchingBracket(source, braceStart, '{', '}');
    if (braceEnd === -1) continue;
    return `var ${name}=${source.slice(braceStart, braceEnd + 1)};`;
  }
  return null;
}

function extractSignatureFunctionName(playerCode) {
  const patterns = [
    /(?:signature|sig)\s*,\s*([A-Za-z0-9$]+)\(/,
    /\.sig\|\|([A-Za-z0-9$]+)\(/,
    /(?:^|[^\w$])([A-Za-z0-9$]{2,})\s*=\s*function\(a\)\{a=a\.split\(""\)/,
    /function\s+([A-Za-z0-9$]{2,})\(a\)\{a=a\.split\(""\)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(playerCode);
    if (match) return match[1];
  }
  return null;
}

function extractSignaturePlan(playerCode) {
  const sigRef = extractSignatureFunctionName(playerCode);
  if (!sigRef) return null;

  const sigFn = extractFunctionByName(playerCode, sigRef);
  if (!sigFn) return { fnRef: sigRef, helperCode: '', fnCode: null };

  const helperMatch = /([A-Za-z0-9$]{2,})\.([A-Za-z0-9$]{2,})\(a,\d+\)/.exec(sigFn)
    || /([A-Za-z0-9$]{2,})\.([A-Za-z0-9$]{2,})\(a\)/.exec(sigFn);
  const helperName = helperMatch?.[1] || null;
  const helperCode = helperName ? extractObjectByName(playerCode, helperName) : '';

  return { fnRef: sigRef, helperCode, fnCode: sigFn };
}

function extractNFunctionRef(playerCode) {
  const patterns = [
    /\.get\("n"\)\)\s*&&\s*\([A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*(?:\[(?:\d+|"[^"]+"|'[^']+')\])?)\([A-Za-z_$][\w$]*\)/,
    /(?:\?|&&)\s*\([A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*(?:\[(?:\d+|"[^"]+"|'[^']+')\])?)\([A-Za-z_$][\w$]*\)\)/,
    /set\("n",\s*([A-Za-z_$][\w$]*(?:\[(?:\d+|"[^"]+"|'[^']+')\])?)\(/,
    /([A-Za-z_$][\w$]{1,})\s*=\s*function\([A-Za-z_$][\w$]*\)\{[\s\S]{0,500}?(?:split\(""\)|String\.prototype\.split\.call\([A-Za-z_$][\w$]*,""\))[\s\S]{0,1000}?join\(""\)[\s\S]{0,120}?\}/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(playerCode);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractNPlan(playerCode) {
  const nRef = extractNFunctionRef(playerCode);
  if (!nRef) return null;

  let helperCode = '';
  let fnCode = null;
  if (/^[A-Za-z_$][\w$]*$/.test(nRef)) {
    fnCode = extractFunctionByName(playerCode, nRef);
    if (fnCode) {
      const helperNames = Array.from(new Set(
        Array.from(fnCode.matchAll(/([A-Za-z0-9$]{2,})\.([A-Za-z0-9$]{2,})\(/g)).map((m) => m[1]),
      ));
      helperCode = helperNames.map((name) => extractObjectByName(playerCode, name)).filter(Boolean).join('\n');
    }
  }

  return { fnRef: nRef, helperCode, fnCode };
}

async function getPlayerPlans(data) {
  const playerUrl = getPlayerUrlFromData(data);
  if (!playerUrl) {
    return { playerUrl: null, playerCode: null, sigPlan: null, nPlan: null, reason: 'Could not locate the current YouTube player script.' };
  }

  if (PLAYER_CACHE.has(playerUrl)) return PLAYER_CACHE.get(playerUrl);

  const promise = (async () => {
    try {
      const response = await fetch(playerUrl, { credentials: 'include' });
      if (!response.ok) {
        return { playerUrl, playerCode: null, sigPlan: null, nPlan: null, reason: `Player JS fetch failed with HTTP ${response.status}.` };
      }
      const code = await response.text();
      return {
        playerUrl,
        playerCode: code,
        sigPlan: extractSignaturePlan(code),
        nPlan: extractNPlan(code),
        reason: null,
      };
    } catch (error) {
      return { playerUrl, playerCode: null, sigPlan: null, nPlan: null, reason: `Could not fetch player JS: ${error?.message || String(error)}` };
    }
  })();

  PLAYER_CACHE.set(playerUrl, promise);
  return promise;
}

async function applySignatureCipher(fmt, plans) {
  const raw = fmt.signatureCipher || fmt.cipher;
  if (!raw) return { url: fmt.url || null, note: null };

  const params = new URLSearchParams(raw);
  const baseUrl = params.get('url');
  const s = params.get('s');
  const sp = params.get('sp') || 'signature';
  const directSig = params.get('sig') || params.get('signature') || params.get('lsig');

  if (!baseUrl) return { url: null, note: 'Cipher payload had no base url.' };

  try {
    const url = new URL(baseUrl);
    if (directSig) {
      url.searchParams.set(sp, directSig);
      return { url: url.toString(), note: 'Used embedded signature from cipher.' };
    }

    if (!s) return { url: url.toString(), note: 'Cipher payload had no encrypted signature.' };

    if (!plans?.playerCode) {
      return { url: null, note: 'Encrypted signature found, but the player JS was not available for deciphering.' };
    }

    const solved = await runPlanInSandbox({
      playerCode: plans.playerCode,
      kind: 'signature',
      arg: s,
    });

    if (!solved?.ok || !solved?.value) {
      return { url: null, note: `Signature decipher failed${solved?.engine ? ` (${solved.engine})` : ''}${solved?.error ? `: ${solved.error}` : ''}.` };
    }

    url.searchParams.set(sp, solved.value);
    return { url: url.toString(), note: `Decrypted signatureCipher with player JS${solved?.engine ? ` via ${solved.engine}` : ''}.` };
  } catch (error) {
    return { url: null, note: `SignatureCipher processing failed: ${error?.message || String(error)}` };
  }
}


function hasNParamInFormat(fmt) {
  try {
    if (fmt?.url && new URL(fmt.url).searchParams.has('n')) return true;
    const raw = fmt?.signatureCipher || fmt?.cipher;
    if (!raw) return false;
    const params = new URLSearchParams(raw);
    const baseUrl = params.get('url');
    return Boolean(baseUrl && new URL(baseUrl).searchParams.has('n'));
  } catch {
    return false;
  }
}

// In content.js — replace applyNTransform

async function applyNTransform(urlString, plans) {
  if (!urlString) return { url: urlString, note: null, failed: false };

  try {
    const url = new URL(urlString);
    const n = url.searchParams.get('n');
    if (!n) return { url: urlString, note: null, failed: false };

    if (!plans?.playerCode) {
      return {
        url: null,
        note: 'URL contains n parameter, but the full player JS was not available.',
        failed: true,
      };
    }

    const solved = await runPlanInWorker({
      playerCode: plans.playerCode,
      kind: 'n',
      arg: n,
    });

    if (!solved?.ok || !solved?.value) {
      return {
        url: null,
        note: `n transform failed${solved?.engine ? ` (${solved.engine})` : ''}${solved?.error ? `: ${solved.error}` : ''}.`,
        failed: true,
      };
    }

    if (String(solved.value) === String(n)) {
      return {
        url: null,
        note: `n transform failed effectively: value stayed unchanged${solved?.engine ? ` via ${solved.engine}` : ''}.`,
        failed: true,
      };
    }

    url.searchParams.set('n', String(solved.value));
    return {
      url: url.toString(),
      note: `Applied player n transform${solved?.engine ? ` via ${solved.engine}` : ''}.`,
      failed: false,
    };
  } catch (error) {
    return {
      url: null,
      note: `n transform processing failed: ${error?.message || String(error)}`,
      failed: true,
    };
  }
}

async function resolveFormatUrl(fmt, plans) {
  if (!fmt) return { url: null, notes: [], nFailed: false };
  const notes = [];
  let url = fmt.url || null;
  let nFailed = false;

  if (!url && (fmt.signatureCipher || fmt.cipher)) {
    const sig = await applySignatureCipher(fmt, plans);
    url = sig.url;
    if (sig.note) notes.push(sig.note);
  }

  if (url) {
    const n = await applyNTransform(url, plans);
    url = n.url;
    nFailed = Boolean(n.failed);
    if (n.note) notes.push(n.note);
  }

  return { url, notes, nFailed };
}

async function resolveManifestUrls(streamingData, plans) {
  const manifestNotes = [];
  const hls = streamingData?.hlsManifestUrl ? await applyNTransform(streamingData.hlsManifestUrl, plans) : { url: null, note: null };
  const dash = streamingData?.dashManifestUrl ? await applyNTransform(streamingData.dashManifestUrl, plans) : { url: null, note: null };
  if (hls.note) manifestNotes.push(`HLS: ${hls.note}`);
  if (dash.note) manifestNotes.push(`DASH: ${dash.note}`);
  return {
    hlsUrl: hls.url || null,
    dashUrl: dash.url || null,
    notes: manifestNotes,
  };
}

async function chooseBestFormats(allFormats, plans, streamingData, { format = 'best', quality = '2160' } = {}) {
  const maxHeight = quality === 'best' ? Infinity : (Number.parseInt(quality, 10) || Infinity);

  const normalized = [];
  for (const fmt of allFormats) {
    const resolved = await resolveFormatUrl(fmt, plans);
    normalized.push({
      ...fmt,
      directUrl: resolved.url,
      notes: resolved.notes,
      isCipheredOnly: !resolved.url && Boolean(fmt.signatureCipher || fmt.cipher),
      hadNParam: hasNParamInFormat(fmt),
      nFailed: Boolean(resolved.nFailed),
      nTransformed: resolved.notes.some((note) => /^Applied player n transform/.test(note)),
    });
  }

  const directFormats = normalized.filter((fmt) => Boolean(fmt.directUrl));
  const progressive = directFormats
    .filter((fmt) => fmt.mimeType?.startsWith('video/') && fmt.mimeType?.includes('audio/') && (fmt.height || 0) <= maxHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));

  const videoOnly = directFormats
    .filter((fmt) => fmt.mimeType?.startsWith('video/') && !fmt.mimeType?.includes('audio/') && (fmt.height || 0) <= maxHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));

  const audioOnly = directFormats
    .filter((fmt) => fmt.mimeType?.startsWith('audio/'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const cipheredCount = normalized.filter((fmt) => fmt.isCipheredOnly).length;
  const solvedCipherCount = normalized.filter((fmt) => fmt.directUrl && (fmt.signatureCipher || fmt.cipher)).length;
  const nParamCount = normalized.filter((fmt) => fmt.hadNParam).length;
  const resolvedNCount = normalized.filter((fmt) => fmt.nTransformed).length;
  const unresolvedNCount = Math.max(nParamCount - resolvedNCount, 0);
  const signaturePlanFound = Boolean(plans?.sigPlan?.fnCode || plans?.sigPlan?.fnRef);
  const directUrlCount = normalized.filter((fmt) => Boolean(fmt.directUrl)).length;
  const allDirectNUnresolved = directFormats.length > 0 && directFormats.every((fmt) => !fmt.hadNParam || !fmt.nTransformed);
  const cipherFailureNotes = Array.from(new Set(
    normalized
      .filter((fmt) => !fmt.directUrl && Boolean(fmt.signatureCipher || fmt.cipher))
      .flatMap((fmt) => fmt.notes.filter((note) => /Signature decipher failed|SignatureCipher processing failed|Encrypted signature found/.test(note)))
      .filter(Boolean),
  ));
  const allNotes = Array.from(new Set(normalized.flatMap((fmt) => fmt.notes).filter(Boolean)));
  allNotes.push(`Format summary: total=${normalized.length}, direct=${directUrlCount}, ciphered=${cipheredCount}, solvedCiphered=${solvedCipherCount}, nTagged=${nParamCount}, nChanged=${resolvedNCount}.`);
  if (unresolvedNCount > 0) {
    allNotes.push(`Throttle risk: ${unresolvedNCount} URL(s) still contain unresolved n parameters.`);
  }
  if (!signaturePlanFound) {
    allNotes.push('No signature transform was detected in the player JS.');
  }
  if (cipheredCount && solvedCipherCount === 0 && cipherFailureNotes.length) {
    allNotes.push(`Signature debug: ${cipherFailureNotes.slice(0, 2).join(' | ')}`);
  }

  const manifests = await resolveManifestUrls(streamingData, plans);
  const manifestAvailable = Boolean(manifests.hlsUrl || manifests.dashUrl);
  allNotes.push(`Manifest summary: hls=${manifests.hlsUrl ? 'yes' : 'no'}, dash=${manifests.dashUrl ? 'yes' : 'no'}.`);
  if (manifests.notes.length) allNotes.push(...manifests.notes);
  if (allDirectNUnresolved && manifestAvailable) {
    allNotes.push('Manifest preference: direct URLs appear throttled because n remained unresolved, so manifest fallback is preferred.');
  }

  if (format === 'video') {
    const video = videoOnly.find((fmt) => /mp4/i.test(fmt.mimeType || '')) || videoOnly[0];
    if (video && !(allDirectNUnresolved && manifestAvailable)) {
      return {
        videoUrl: video.directUrl,
        audioUrl: null,
        strategy: 'video-only',
        reason: 'Video-only test mode selected — using a direct video stream without audio or remux.',
        cipheredCount,
        solvedCipherCount,
        totalFormats: normalized.length,
        nParamCount,
        resolvedNCount,
        isLikelyThrottledDirect: Boolean(video.hadNParam && !video.nTransformed),
        containerExt: /webm/i.test(video.mimeType || '') ? 'webm' : 'mp4',
        notes: allNotes,
      };
    }

    if (manifests.hlsUrl) {
      return {
        videoUrl: manifests.hlsUrl,
        audioUrl: null,
        strategy: 'hls-manifest-video',
        reason: allDirectNUnresolved
          ? 'Direct video URLs looked throttled because n stayed unresolved, so the extension preferred the HLS manifest.'
          : 'No direct video-only URL was usable, so the extension fell back to the HLS manifest.',
        cipheredCount,
        solvedCipherCount,
        totalFormats: normalized.length,
        nParamCount,
        resolvedNCount,
        isLikelyThrottledDirect: false,
        notes: allNotes,
      };
    }

    if (manifests.dashUrl) {
      return {
        videoUrl: manifests.dashUrl,
        audioUrl: null,
        strategy: 'dash-manifest-video',
        reason: allDirectNUnresolved
          ? 'Direct video URLs looked throttled because n stayed unresolved, so the extension preferred the DASH manifest.'
          : 'No direct video-only URL was usable, so the extension fell back to the DASH manifest.',
        cipheredCount,
        solvedCipherCount,
        totalFormats: normalized.length,
        nParamCount,
        resolvedNCount,
        isLikelyThrottledDirect: false,
        notes: allNotes,
      };
    }

    return {
      videoUrl: null,
      audioUrl: null,
      strategy: 'none',
      reason: 'No direct video-only stream URL was exposed on the page.',
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: false,
      notes: allNotes,
    };
  }

  if (format === 'audio') {
    const audio = audioOnly.find((fmt) => /mp4|mp3|mpeg/i.test(fmt.mimeType || '')) || audioOnly[0];
    if (audio && !(allDirectNUnresolved && manifestAvailable)) {
      return {
        videoUrl: audio.directUrl,
        audioUrl: null,
        strategy: 'audio-only',
        reason: null,
        cipheredCount,
        solvedCipherCount,
        totalFormats: normalized.length,
        nParamCount,
        resolvedNCount,
        isLikelyThrottledDirect: Boolean(audio.hadNParam && !audio.nTransformed),
        containerExt: /webm/i.test(audio.mimeType || '') ? 'webm' : (/mpeg|mp3/i.test(audio.mimeType || '') ? 'mp3' : 'm4a'),
        notes: allNotes,
      };
    }

    if (manifests.hlsUrl) {
      return {
        videoUrl: manifests.hlsUrl,
        audioUrl: null,
        strategy: 'hls-manifest-audio',
        reason: allDirectNUnresolved
          ? 'Direct audio URLs looked throttled because n stayed unresolved, so the extension preferred the HLS manifest.'
          : 'No direct audio URL was usable, so the extension fell back to the HLS manifest.',
        cipheredCount,
        solvedCipherCount,
        totalFormats: normalized.length,
        nParamCount,
        resolvedNCount,
        isLikelyThrottledDirect: false,
        notes: allNotes,
      };
    }

    if (manifests.dashUrl) {
      return {
        videoUrl: manifests.dashUrl,
        audioUrl: null,
        strategy: 'dash-manifest-audio',
        reason: allDirectNUnresolved
          ? 'Direct audio URLs looked throttled because n stayed unresolved, so the extension preferred the DASH manifest.'
          : 'No direct audio URL was usable, so the extension fell back to the DASH manifest.',
        cipheredCount,
        solvedCipherCount,
        totalFormats: normalized.length,
        nParamCount,
        resolvedNCount,
        isLikelyThrottledDirect: false,
        notes: allNotes,
      };
    }

    return {
      videoUrl: null,
      audioUrl: null,
      strategy: 'none',
      reason: cipheredCount ? 'Audio streams were found, but deciphering did not yield a usable direct URL or manifest fallback.' : 'No direct audio stream URL was exposed on the page.',
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: false,
      notes: allNotes,
    };
  }

  const bestWebmVideo = videoOnly.find((fmt) => /webm/i.test(fmt.mimeType || ''));
  const bestWebmAudio = audioOnly.find((fmt) => /webm/i.test(fmt.mimeType || ''));
  const bestMp4Video = videoOnly.find((fmt) => /mp4/i.test(fmt.mimeType || ''));
  const bestMp4Audio = audioOnly.find((fmt) => /mp4|m4a/i.test(fmt.mimeType || ''));

  const preferredVideo = (bestWebmVideo && bestWebmAudio) ? bestWebmVideo
    : (bestMp4Video && bestMp4Audio) ? bestMp4Video
    : videoOnly[0];
  const preferredAudio = (bestWebmVideo && bestWebmAudio) ? bestWebmAudio
    : (bestMp4Video && bestMp4Audio) ? bestMp4Audio
    : audioOnly[0];
  const containerExt = (bestWebmVideo && bestWebmAudio) ? 'webm' : 'mp4';

  const preferredProgressive = progressive.find((fmt) => /mp4/i.test(fmt.mimeType || '')) || progressive[0];

  if (allDirectNUnresolved && manifests.hlsUrl) {
    return {
      videoUrl: manifests.hlsUrl,
      audioUrl: null,
      strategy: 'hls-manifest',
      reason: 'Direct HTTPS URLs looked throttled because n stayed unresolved, so the extension preferred the HLS manifest.',
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: false,
      notes: allNotes,
    };
  }

  if (allDirectNUnresolved && manifests.dashUrl) {
    return {
      videoUrl: manifests.dashUrl,
      audioUrl: null,
      strategy: 'dash-manifest',
      reason: 'Direct HTTPS URLs looked throttled because n stayed unresolved, so the extension preferred the DASH manifest.',
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: false,
      notes: allNotes,
    };
  }

  if (preferredVideo && preferredAudio) {
    return {
      videoUrl: preferredVideo.directUrl,
      audioUrl: preferredAudio.directUrl,
      containerExt,
      strategy: 'adaptive-mux',
      reason: null,
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: Boolean((preferredVideo.hadNParam && !preferredVideo.nTransformed) || (preferredAudio.hadNParam && !preferredAudio.nTransformed)),
      notes: allNotes,
    };
  }

  if (preferredProgressive) {
    return {
      videoUrl: preferredProgressive.directUrl,
      audioUrl: null,
      strategy: 'progressive',
      reason: null,
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: Boolean(preferredProgressive.hadNParam && !preferredProgressive.nTransformed),
      notes: allNotes,
    };
  }

  if (manifests.hlsUrl) {
    return {
      videoUrl: manifests.hlsUrl,
      audioUrl: null,
      strategy: 'hls-manifest',
      reason: 'No direct HTTPS URL was usable, so the extension fell back to the HLS manifest.',
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: false,
      notes: allNotes,
    };
  }

  if (manifests.dashUrl) {
    return {
      videoUrl: manifests.dashUrl,
      audioUrl: null,
      strategy: 'dash-manifest',
      reason: 'No direct HTTPS URL was usable, so the extension fell back to the DASH manifest.',
      cipheredCount,
      solvedCipherCount,
      totalFormats: normalized.length,
      nParamCount,
      resolvedNCount,
      isLikelyThrottledDirect: false,
      notes: allNotes,
    };
  }

  return {
    videoUrl: null,
    audioUrl: null,
    strategy: 'none',
    reason: cipheredCount
      ? `Found ${normalized.length} format(s), but deciphering still did not produce a playable direct URL or manifest fallback.`
      : 'No usable direct stream URLs or manifests were exposed by YouTube on this page.',
    cipheredCount,
    solvedCipherCount,
    totalFormats: normalized.length,
    nParamCount,
    resolvedNCount,
    isLikelyThrottledDirect: false,
    notes: allNotes,
  };
}


function scoreResolvedCandidate(candidateName, resolved) {
  let score = 0;
  if (resolved?.videoUrl || resolved?.audioUrl) score += 1000;
  if (resolved?.strategy === 'adaptive-mux') score += 300;
  else if (resolved?.strategy === 'progressive') score += 220;
  else if (resolved?.strategy === 'audio-only') score += 180;
  else if (resolved?.strategy && /manifest/.test(resolved.strategy)) score += 80;

  const directEstimate = Math.max((resolved?.totalFormats || 0) - (resolved?.cipheredCount || 0), 0);
  score += directEstimate * 4;
  score -= (resolved?.cipheredCount || 0) * 2;
  score -= Math.max((resolved?.nParamCount || 0) - (resolved?.resolvedNCount || 0), 0) * 3;

  if (candidateName === 'ANDROID_VR') score += 180;
  else if (candidateName === 'ANDROID') score += 120;
  else if (candidateName === 'MWEB') score += 20;
  else if (candidateName === 'WEB') score += 10;
  else if (candidateName === 'WEB_SAFARI') score += 5;
  else if (candidateName === 'PAGE') score += 15;

  return score;
}

function makeCandidateNote(candidateName, resolved) {
  const parts = [];
  if (Number.isFinite(resolved?.totalFormats)) parts.push(`formats=${resolved.totalFormats}`);
  if (Number.isFinite(resolved?.cipheredCount)) parts.push(`ciphered=${resolved.cipheredCount}`);
  if (Number.isFinite(resolved?.solvedCipherCount)) parts.push(`solvedCiphered=${resolved.solvedCipherCount}`);
  if (Number.isFinite(resolved?.nParamCount)) parts.push(`nTagged=${resolved.nParamCount}`);
  if (Number.isFinite(resolved?.resolvedNCount)) parts.push(`nChanged=${resolved.resolvedNCount}`);
  if (resolved?.strategy) parts.push(`mode=${resolved.strategy}`);
  if (resolved?.videoUrl || resolved?.audioUrl) parts.push('usable=yes');
  else parts.push('usable=no');
  return `${candidateName}: ${parts.join(' • ')}`;
}

async function evaluateCandidate(playerResponse, candidateName, plans, options) {
  const streamingData = playerResponse?.streamingData;
  if (!streamingData) {
    return {
      clientName: candidateName,
      score: -1000,
      notes: [`${candidateName}: no streaming data.`],
      resolved: {
        videoUrl: null,
        audioUrl: null,
        strategy: 'none',
        reason: `${candidateName}: no streaming data.`,
        totalFormats: 0,
        cipheredCount: 0,
        solvedCipherCount: 0,
        nParamCount: 0,
        resolvedNCount: 0,
      },
    };
  }

  const allFormats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || []),
  ];

  const resolved = await chooseBestFormats(allFormats, plans, streamingData, options);
  const notes = [makeCandidateNote(candidateName, resolved)];
  if (!resolved.videoUrl && !resolved.audioUrl) {
    notes.push(`${candidateName}: skipped because no usable direct stream URLs or manifests were exposed.`);
  }

  return {
    clientName: candidateName,
    score: scoreResolvedCandidate(candidateName, resolved),
    notes,
    resolved,
  };
}

async function getStreamUrls(options = {}) {
  try {
    const data = await getPageData();
    const notes = [];
    const candidates = [];
    const seenCandidateNames = new Set();

    const plans = await getPlayerPlans(data);
    if (plans.reason) notes.push(plans.reason);
    if (plans.playerCode) notes.push('Fetched the current YouTube player JS for signature and n transforms.');
    if (plans.sigPlan?.fnCode || plans.sigPlan?.fnRef) notes.push('signature transform detected in the player JS.');
    else notes.push('no signature transform detected in the player JS.');
    if (plans.nPlan?.fnRef) notes.push('n transform detected in the player JS.');
    else notes.push('no n transform detected in the player JS.');

    if (data.playerResponse?.streamingData) {
      notes.push('Loaded streaming data from page globals or inline scripts.');
      candidates.push(await evaluateCandidate(data.playerResponse, 'PAGE', plans, options));
      seenCandidateNames.add('PAGE');
    } else {
      notes.push('No streaming data in page globals; trying YouTube player API fallbacks.');
    }

    for (const profile of getPreferredInnertubeProfiles(data)) {
      if (seenCandidateNames.has(profile.name)) continue;
      const fallback = await fetchPlayerResponseFromInnertube(data, profile);
      if (fallback.reason) notes.push(fallback.reason);
      if (fallback.playerResponse?.streamingData) {
        candidates.push(await evaluateCandidate(fallback.playerResponse, profile.name, plans, options));
        seenCandidateNames.add(profile.name);
      }
    }

    if (!candidates.length) {
      return {
        videoUrl: null,
        audioUrl: null,
        strategy: 'none',
        reason: notes.join(' '),
        debug: { playabilityStatus: data.playerResponse?.playabilityStatus?.status || null },
      };
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const chosen = { ...best.resolved };
    chosen.selectedClient = best.clientName;
    chosen.reason = [
      ...notes,
      ...candidates.flatMap((candidate) => candidate.notes),
      `Selected client: ${best.clientName}.`,
      chosen.reason || '',
    ].filter(Boolean).join(' ');
    return chosen;
  } catch (error) {
    console.warn('[yt-browser-downloader] getStreamUrls error:', error);
    return {
      videoUrl: null,
      audioUrl: null,
      strategy: 'none',
      reason: error?.message || String(error),
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'GET_VIDEO_INFO') {
      sendResponse(await getVideoInfo());
      return;
    }

    if (message.type === 'GET_STREAM_URLS') {
      sendResponse(await getStreamUrls(message));
      return;
    }

    sendResponse(null);
  })().catch((error) => {
    sendResponse({ error: error?.message || String(error) });
  });

  return true;
});

let lastUrl = location.href;
const observer = new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    try {
      if (hasExtensionRuntime()) {
        chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', url }).catch(() => {});
      }
    } catch {}
  }
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  window.addEventListener('DOMContentLoaded', () => {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }, { once: true });
}
