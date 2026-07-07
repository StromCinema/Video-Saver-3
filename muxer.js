/**
 * muxer.js — Web Worker (classic worker)
 *
 * Handles YouTube adaptive streams:
 *   - plain MP4 + plain MP4 → merged MP4  (MP4Box)
 *   - fMP4/CMAF + fMP4/CMAF → merged MP4  (pure-JS fMP4 muxer)
 *   - WebM/MKV video + audio → separate fallback downloads for now
 *     Hook is ready for future muxWebmPair() implementation.
 *   - mixed containers → rejected cleanly
 *
 * Requires mp4box_all_min.js in the same extension directory (for MP4 only).
 *
 * Message in:  { type:'mux', videoUrl, audioUrl, title, format, containerExt }
 * Messages out:
 *   { type:'log'|'progress'|'done'|'error', ... }
 *   { type:'file', blobUrl, filename, size } // for separate fallback downloads
 */

'use strict';

const BASE_URL = self.location.href.replace(/\/[^/]+$/, '');

// ─── Messaging ────────────────────────────────────────────────────────────────

function post(type, payload = {}) { self.postMessage({ type, ...payload }); }
function log(msg)      { post('log',      { message: msg }); }
function progress(msg) { post('progress', { message: msg }); }

function postFile(blob, filename) {
  post('file', {
    blobUrl: URL.createObjectURL(blob),
    filename,
    size: blob.size,
  });
}

let activeAbortController = null;
let transferProgress = { video: { loaded: 0, total: 0 }, audio: { loaded: 0, total: 0 } };

function resetTransferProgress() {
  transferProgress = {
    video: { loaded: 0, total: 0 },
    audio: { loaded: 0, total: 0 },
  };
}

function reportCombinedProgress() {
  const loaded = (transferProgress.video.loaded || 0) + (transferProgress.audio.loaded || 0);
  const total = (transferProgress.video.total || 0) + (transferProgress.audio.total || 0);
  if (total > 0) {
    progress(`Downloading… ${formatBytes(loaded)} / ${formatBytes(total)}`);
  } else {
    progress(`Downloading… ${formatBytes(loaded)}`);
  }
}

// ─── Worker entry ─────────────────────────────────────────────────────────────

self.onmessage = async (evt) => {
  const msg = evt.data || {};
  if (msg.type === 'abort') {
    if (activeAbortController) activeAbortController.abort();
    post('error', { message: 'Aborted' });
    return;
  }
  if (msg.type === 'mux') {
    resetTransferProgress();
    activeAbortController = new AbortController();
    try {
      await runMux(msg, activeAbortController.signal);
    } finally {
      activeAbortController = null;
    }
  }
};

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function runMux({ videoUrl, audioUrl, title, format, containerExt = 'mp4' }, signal) {
  try {
    log('muxer.js v3 — pure-JS MP4 path active (no MP4Box for mux)');
    const safeTitle = sanitizeFilename(title || 'video');
    const ext = normalizeExt(format, containerExt);
    const filename = `${safeTitle}.${ext}`;

    if (format === 'audio' || !audioUrl) {
      const kind = format === 'audio' ? 'audio' : 'video';
      log(`Fetching ${kind} stream…`);
      progress(`Downloading ${kind}…`);
      const data = await fetchStream(videoUrl, kind, signal);
      log(`Downloaded: ${formatBytes(data.byteLength)}`);
      const mime = sniffSingleStreamMime(data, format === 'audio');
      const outExt = inferSingleStreamExt(data, format === 'audio', ext);
      const blob = new Blob([data], { type: mime });
      post('done', {
        blobUrl: URL.createObjectURL(blob),
        filename: `${safeTitle}.${outExt}`,
        size: blob.size,
      });
      return;
    }

    log('Fetching video + audio streams in parallel…');
    progress('Downloading…');
    const [vData, aData] = await Promise.all([
      fetchStream(videoUrl, 'video', signal),
      fetchStream(audioUrl, 'audio', signal),
    ]);
    log(`Video: ${formatBytes(vData.byteLength)}, Audio: ${formatBytes(aData.byteLength)}`);

    const vContainer = sniffContainer(vData);
    const aContainer = sniffContainer(aData);
    log(`Detected containers: video=${describeContainer(vContainer)}, audio=${describeContainer(aContainer)}`);

    if (isMp4Family(vContainer) && isMp4Family(aContainer)) {
      let blob;
      // Always use the pure-JS ISO BMFF muxer.
      // Plain MP4 from YouTube is really a single-fragment ISO file (moov + mdat).
      // normaliseToFmp4() converts it to a proper fMP4 stream so muxFmp4() can merge it.
      // This avoids MP4Box entirely and eliminates its DataView crash on large boxes.
      const vFmp4 = normaliseToFmp4(vData, 'video');
      const aFmp4 = normaliseToFmp4(aData, 'audio');
      if (vContainer === 'fmp4' || aContainer === 'fmp4') {
        log('Fragmented MP4 detected — using pure-JS fMP4 muxer…');
      } else {
        log('Plain MP4 detected — normalising to fMP4 then merging…');
      }
      progress('Merging MP4…');
      blob = await muxFmp4(vFmp4, aFmp4);

      post('done', {
        blobUrl: URL.createObjectURL(blob),
        filename: `${safeTitle}.mp4`,
        size: blob.size,
      });
      return;
    }

    if (isWebmFamily(vContainer) && isWebmFamily(aContainer)) {
      log('WebM/Matroska streams detected.');

      if (canMuxWebmPair()) {
        try {
          progress('Merging WebM…');
          const blob = await muxWebmPair(vData, aData, { title: safeTitle, signal, containerExt });
          const mergedExt = containerExt === 'mkv' ? 'mkv' : 'webm';
          const mergedMime = mergedExt === 'mkv' ? 'video/x-matroska' : 'video/webm';
          const outBlob = blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: mergedMime });
          post('done', {
            blobUrl: URL.createObjectURL(outBlob),
            filename: `${safeTitle}.${mergedExt}`,
            size: outBlob.size,
          });
          return;
        } catch (err) {
          log(`WebM mux failed, falling back to separate downloads (${err?.message || err})`);
        }
      } else {
        log('WebM mux unavailable or failed, falling back to separate downloads (muxWebmPair() not implemented yet)');
      }

      const videoExt = vContainer === 'matroska' || String(containerExt).toLowerCase() === 'mkv' ? 'mkv' : 'webm';
      const audioExt = aContainer === 'matroska' ? 'mka' : 'webm';
      const videoMime = videoExt === 'mkv' ? 'video/x-matroska' : 'video/webm';
      const audioMime = audioExt === 'mka' ? 'audio/x-matroska' : 'audio/webm';

      postFile(new Blob([vData], { type: videoMime }), `${safeTitle}.video.${videoExt}`);
      postFile(new Blob([aData], { type: audioMime }), `${safeTitle}.audio.${audioExt}`);
      post('done', { separate: true, files: 2 });
      return;
    }

    throw new Error(
      `Unsupported mixed containers: video=${describeContainer(vContainer)}, audio=${describeContainer(aContainer)}`
    );

  } catch (err) {
    post('error', { message: err?.message || String(err) });
  }
}

// ─── Container sniffing ───────────────────────────────────────────────────────

function sniffContainer(data) {
  if (!data || data.length < 12) return 'unknown';

  // EBML header magic
  if (data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) {
    const docType = sniffEbmlDocType(data);
    if (docType === 'matroska') return 'matroska';
    return 'webm';
  }

  // Scan first few top-level ISO BMFF boxes instead of assuming offset 4 only.
  const limit = Math.min(data.length, 256);
  let offset = 0;
  while (offset + 8 <= limit) {
    const size = readU32BE(data, offset);
    const type = readFourCC(data, offset + 4);

    if (type === 'ftyp' || type === 'moov' || type === 'mdat' || type === 'free' || type === 'wide' || type === 'skip') {
      return 'mp4';
    }
    if (type === 'moof' || type === 'styp' || type === 'sidx' || type === 'emsg') {
      return 'fmp4';
    }

    if (!Number.isFinite(size) || size < 8) break;
    offset += size;
  }

  // Last chance: many ISO files still expose recognizable box names at offset 4.
  const boxName = readFourCC(data, 4);
  if (boxName === 'ftyp' || boxName === 'moov' || boxName === 'mdat' || boxName === 'free' || boxName === 'wide' || boxName === 'skip') {
    return 'mp4';
  }
  if (boxName === 'moof' || boxName === 'styp' || boxName === 'sidx' || boxName === 'emsg') {
    return 'fmp4';
  }

  return 'unknown';
}

function sniffEbmlDocType(data) {
  const maxOffset = Math.min(data.length, 4096);
  let offset = 4; // after EBML header magic

  while (offset + 2 <= maxOffset) {
    let idInfo, sizeInfo;
    try {
      idInfo = readEbmlId(data, offset);
      sizeInfo = readVint(data, offset + idInfo.len);
    } catch {
      break;
    }

    const payloadStart = offset + idInfo.len + sizeInfo.len;
    const payloadEnd = Math.min(payloadStart + sizeInfo.val, maxOffset);

    // DocType
    if (idInfo.id === 0x4282 && payloadEnd > payloadStart) {
      const docType = new TextDecoder().decode(data.slice(payloadStart, payloadEnd)).toLowerCase();
      if (docType.includes('matroska')) return 'matroska';
      if (docType.includes('webm')) return 'webm';
      return docType;
    }

    if (sizeInfo.val <= 0 || payloadEnd <= offset) break;
    offset = payloadEnd;
  }

  // Raw text fallback for non-ideal encoders.
  const text = new TextDecoder('ascii', { fatal: false }).decode(data.slice(0, maxOffset)).toLowerCase();
  if (text.includes('matroska')) return 'matroska';
  if (text.includes('webm')) return 'webm';
  return '';
}

function isMp4Family(container) {
  return container === 'mp4' || container === 'fmp4';
}

function isWebmFamily(container) {
  return container === 'webm' || container === 'matroska';
}

function describeContainer(container) {
  switch (container) {
    case 'mp4': return 'MP4';
    case 'fmp4': return 'fMP4';
    case 'webm': return 'WebM/EBML';
    case 'matroska': return 'Matroska/EBML';
    default: return 'unknown';
  }
}

function sniffSingleStreamMime(data, isAudio) {
  const container = sniffContainer(data);
  if (container === 'webm') return isAudio ? 'audio/webm' : 'video/webm';
  if (container === 'matroska') return isAudio ? 'audio/x-matroska' : 'video/x-matroska';
  return isAudio ? 'audio/mp4' : 'video/mp4';
}

function inferSingleStreamExt(data, isAudio, fallbackExt) {
  const container = sniffContainer(data);
  if (container === 'webm') return 'webm';
  if (container === 'matroska') return isAudio ? 'mka' : 'mkv';
  if (isAudio) return 'm4a';
  return normalizeExt('video', fallbackExt);
}

function readU32BE(data, offset) {
  return (((data[offset] << 24) >>> 0) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readFourCC(data, offset) {
  if (offset + 4 > data.length) return '????';
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

// ═════════════════════════════════════════════════════════════════════════════
// WebM / MKV pure-JS merger
//
// YouTube WebM adaptive streams are single-track EBML/Matroska files.
// We parse both, rewrite track IDs in every SimpleBlock/Block, and emit
// one merged MKV with video track 1 + audio track 2. No re-encoding needed.
// ═════════════════════════════════════════════════════════════════════════════

const EBML_ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, Info: 0x1549A966,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7,
  TrackUID: 0x73C5, TrackType: 0x83, FlagEnabled: 0xB9,
  FlagDefault: 0x88, FlagLacing: 0x9C, CodecID: 0x86,
  CodecPrivate: 0x63A2, DefaultDuration: 0x23E383,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA,
  Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
  TimecodeScale: 0x2AD7B1, Cluster: 0x1F43B675,
  Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
};

function ebmlConcatU8(...arrays) {
  let total = 0; for (const a of arrays) total += a.length;
  const out = new Uint8Array(total); let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function ebmlEncVint(val) {
  if (val < 0x7F)       return new Uint8Array([0x80 | val]);
  if (val < 0x3FFF)     return new Uint8Array([0x40 | (val >> 8), val & 0xFF]);
  if (val < 0x1FFFFF)   return new Uint8Array([0x20 | (val >> 16), (val >> 8) & 0xFF, val & 0xFF]);
  if (val < 0x0FFFFFFF) return new Uint8Array([0x10 | (val >>> 24), (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]);
  return new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]); // unknown size
}

function ebmlEncId(id) {
  if (id <= 0xFF)     return new Uint8Array([id]);
  if (id <= 0xFFFF)   return new Uint8Array([id >> 8, id & 0xFF]);
  if (id <= 0xFFFFFF) return new Uint8Array([id >> 16, (id >> 8) & 0xFF, id & 0xFF]);
  return new Uint8Array([(id >>> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]);
}

function ebmlEncUint(val) {
  if (val === 0) return new Uint8Array([0]);
  const b = []; let v = val >>> 0;
  while (v > 0) { b.unshift(v & 0xFF); v = Math.floor(v / 256); }
  return new Uint8Array(b);
}

function ebmlEncFloat32(val) {
  const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, val, false); return new Uint8Array(b);
}

function ebmlEl(id, ...payloads) {
  const p = ebmlConcatU8(...payloads);
  return ebmlConcatU8(ebmlEncId(id), ebmlEncVint(p.length), p);
}

function ebmlElRaw(id, data) {
  return ebmlConcatU8(ebmlEncId(id), ebmlEncVint(data.length), data);
}

function ebmlDecVint(data, offset) {
  const b0 = data[offset];
  // EBML VINT: leading 1-bit determines byte length. Unknown-size = all data bits set.
  if (b0 & 0x80) { const v = b0 & 0x7F; return { val: v, len: 1, unknown: v === 0x7F }; }
  if (b0 & 0x40) { const v = ((b0 & 0x3F) << 8) | data[offset+1]; return { val: v, len: 2, unknown: v === 0x3FFF }; }
  if (b0 & 0x20) { const v = ((b0 & 0x1F) << 16) | (data[offset+1] << 8) | data[offset+2]; return { val: v, len: 3, unknown: v === 0x1FFFFF }; }
  if (b0 & 0x10) { const v = ((b0 & 0x0F) * 0x1000000) | (data[offset+1] << 16) | (data[offset+2] << 8) | data[offset+3]; return { val: v, len: 4, unknown: v === 0x0FFFFFFF }; }
  if (b0 & 0x08) return { val: 0, len: 5, unknown: true };
  if (b0 & 0x04) return { val: 0, len: 6, unknown: true };
  if (b0 & 0x02) return { val: 0, len: 7, unknown: true };
  if (b0 & 0x01) return { val: 0, len: 8, unknown: true }; // 01 FF FF FF FF FF FF FF — used by YouTube Segment
  throw new Error(`Unsupported VINT 0x${b0.toString(16)} at ${offset}`);
}

function ebmlDecId(data, offset) {
  const b0 = data[offset];
  if (b0 & 0x80) return { id: b0, len: 1 };
  if (b0 & 0x40) return { id: (b0 << 8) | data[offset + 1], len: 2 };
  if (b0 & 0x20) return { id: (b0 << 16) | (data[offset + 1] << 8) | data[offset + 2], len: 3 };
  if (b0 & 0x10) return { id: (b0 * 0x1000000) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3], len: 4 };
  throw new Error(`Unsupported EBML ID 0x${b0.toString(16)} at ${offset}`);
}

function ebmlParseChildren(data, start, end) {
  const els = []; let i = start;
  while (i + 2 <= end) {
    let idInfo, sizeInfo;
    try { idInfo = ebmlDecId(data, i); sizeInfo = ebmlDecVint(data, i + idInfo.len); } catch { break; }
    const ds = i + idInfo.len + sizeInfo.len;
    const isUnknown = sizeInfo.unknown === true;
    const de = isUnknown ? end : Math.min(ds + sizeInfo.val, end);
    els.push({ id: idInfo.id, dataStart: ds, dataEnd: de });
    i = de;
  }
  return els;
}

function ebmlReadUint(data, s, e) {
  let v = 0; for (let i = s; i < e; i++) v = v * 256 + data[i]; return v;
}

function ebmlReadFloat(data, s, e) {
  const view = new DataView(data.buffer, data.byteOffset + s, e - s);
  return (e - s) === 8 ? view.getFloat64(0, false) : view.getFloat32(0, false);
}

function ebmlParseWebm(data) {
  const top = ebmlParseChildren(data, 0, data.length);
  const segEl = top.find(e => e.id === EBML_ID.Segment);
  if (!segEl) throw new Error('No EBML Segment found');

  const segEls = ebmlParseChildren(data, segEl.dataStart, segEl.dataEnd);

  let timecodeScale = 1_000_000;
  const infoEl = segEls.find(e => e.id === EBML_ID.Info);
  if (infoEl) {
    const ch = ebmlParseChildren(data, infoEl.dataStart, infoEl.dataEnd);
    const ts = ch.find(e => e.id === EBML_ID.TimecodeScale);
    if (ts) timecodeScale = ebmlReadUint(data, ts.dataStart, ts.dataEnd);
  }

  const tracksEl = segEls.find(e => e.id === EBML_ID.Tracks);
  if (!tracksEl) throw new Error('No Tracks element in WebM');

  const tracks = ebmlParseChildren(data, tracksEl.dataStart, tracksEl.dataEnd)
    .filter(e => e.id === EBML_ID.TrackEntry)
    .map(te => {
      const ch = ebmlParseChildren(data, te.dataStart, te.dataEnd);
      const c = (id) => ch.find(e => e.id === id) || null;
      const numEl = c(EBML_ID.TrackNumber), typeEl = c(EBML_ID.TrackType);
      const cidEl = c(EBML_ID.CodecID),     cpEl = c(EBML_ID.CodecPrivate);
      const ddEl  = c(EBML_ID.DefaultDuration);
      const vidEl = c(EBML_ID.Video),        audEl = c(EBML_ID.Audio);

      let video = null, audio = null;
      if (vidEl) {
        const vc = ebmlParseChildren(data, vidEl.dataStart, vidEl.dataEnd);
        const wEl = vc.find(e => e.id === EBML_ID.PixelWidth);
        const hEl = vc.find(e => e.id === EBML_ID.PixelHeight);
        video = { width: wEl ? ebmlReadUint(data, wEl.dataStart, wEl.dataEnd) : 1920,
                  height: hEl ? ebmlReadUint(data, hEl.dataStart, hEl.dataEnd) : 1080 };
      }
      if (audEl) {
        const ac  = ebmlParseChildren(data, audEl.dataStart, audEl.dataEnd);
        const sfEl = ac.find(e => e.id === EBML_ID.SamplingFrequency);
        const chEl = ac.find(e => e.id === EBML_ID.Channels);
        audio = { samplingFrequency: sfEl ? ebmlReadFloat(data, sfEl.dataStart, sfEl.dataEnd) : 48000,
                  channels: chEl ? ebmlReadUint(data, chEl.dataStart, chEl.dataEnd) : 2 };
      }

      return {
        origNum:         numEl  ? ebmlReadUint(data, numEl.dataStart, numEl.dataEnd)  : 1,
        trackType:       typeEl ? ebmlReadUint(data, typeEl.dataStart, typeEl.dataEnd) : 0,
        codecId:         cidEl  ? new TextDecoder().decode(data.slice(cidEl.dataStart, cidEl.dataEnd)) : '',
        codecPrivate:    cpEl   ? data.slice(cpEl.dataStart, cpEl.dataEnd) : null,
        defaultDuration: ddEl   ? ebmlReadUint(data, ddEl.dataStart, ddEl.dataEnd) : 0,
        video, audio,
      };
    });

  const clusterRanges = segEls
    .filter(e => e.id === EBML_ID.Cluster)
    .map(e => ({ start: e.dataStart, end: e.dataEnd }));

  return { timecodeScale, tracks, clusterRanges, data };
}

function ebmlPatchTrackNum(block, offset, oldNum, newNum) {
  const tv = ebmlDecVint(block, offset);
  if (tv.val !== oldNum) return;
  const nv = ebmlEncVint(newNum);
  if (nv.length === tv.len) block.set(nv, offset);
}

function ebmlRebuildClusters(info, oldNum, newNum) {
  const { data, clusterRanges } = info;
  return clusterRanges.map(({ start, end }) => {
    const children = ebmlParseChildren(data, start, end);
    const parts = [];
    for (const ch of children) {
      if (ch.id === EBML_ID.Timecode) {
        parts.push(ebmlElRaw(EBML_ID.Timecode, data.slice(ch.dataStart, ch.dataEnd)));
      } else if (ch.id === EBML_ID.SimpleBlock) {
        const block = data.slice(ch.dataStart, ch.dataEnd).slice();
        ebmlPatchTrackNum(block, 0, oldNum, newNum);
        parts.push(ebmlElRaw(EBML_ID.SimpleBlock, block));
      } else if (ch.id === EBML_ID.BlockGroup) {
        const bgChildren = ebmlParseChildren(data, ch.dataStart, ch.dataEnd);
        const bgParts = [];
        for (const bg of bgChildren) {
          if (bg.id === EBML_ID.Block) {
            const block = data.slice(bg.dataStart, bg.dataEnd).slice();
            ebmlPatchTrackNum(block, 0, oldNum, newNum);
            bgParts.push(ebmlElRaw(EBML_ID.Block, block));
          } else {
            bgParts.push(ebmlElRaw(bg.id, data.slice(bg.dataStart, bg.dataEnd)));
          }
        }
        parts.push(ebmlEl(EBML_ID.BlockGroup, ...bgParts));
      } else {
        parts.push(ebmlElRaw(ch.id, data.slice(ch.dataStart, ch.dataEnd)));
      }
    }
    return ebmlEl(EBML_ID.Cluster, ...parts);
  });
}

function ebmlBuildTrackEntry(track, newId) {
  const parts = [
    ebmlEl(EBML_ID.TrackNumber,  ebmlEncUint(newId)),
    ebmlEl(EBML_ID.TrackUID,     ebmlEncUint(newId)),
    ebmlEl(EBML_ID.TrackType,    ebmlEncUint(track.trackType)),
    ebmlEl(EBML_ID.FlagEnabled,  ebmlEncUint(1)),
    ebmlEl(EBML_ID.FlagDefault,  ebmlEncUint(1)),
    ebmlEl(EBML_ID.FlagLacing,   ebmlEncUint(0)),
    ebmlEl(EBML_ID.CodecID,      new TextEncoder().encode(track.codecId)),
  ];
  if (track.codecPrivate)    parts.push(ebmlElRaw(EBML_ID.CodecPrivate, track.codecPrivate));
  if (track.defaultDuration) parts.push(ebmlEl(EBML_ID.DefaultDuration, ebmlEncUint(track.defaultDuration)));
  if (track.video) {
    parts.push(ebmlEl(EBML_ID.Video,
      ebmlEl(EBML_ID.PixelWidth,  ebmlEncUint(track.video.width)),
      ebmlEl(EBML_ID.PixelHeight, ebmlEncUint(track.video.height)),
    ));
  }
  if (track.audio) {
    parts.push(ebmlEl(EBML_ID.Audio,
      ebmlElRaw(EBML_ID.SamplingFrequency, ebmlEncFloat32(track.audio.samplingFrequency)),
      ebmlEl(EBML_ID.Channels, ebmlEncUint(track.audio.channels)),
    ));
  }
  return ebmlEl(EBML_ID.TrackEntry, ...parts);
}

async function muxWebmPair(vData, aData) {
  progress('Parsing video track…');
  const vInfo = ebmlParseWebm(vData);
  progress('Parsing audio track…');
  const aInfo = ebmlParseWebm(aData);

  const vTrack = vInfo.tracks.find(t => t.trackType === 1);
  const aTrack = aInfo.tracks.find(t => t.trackType === 2);
  if (!vTrack) throw new Error('No video track in WebM video stream');
  if (!aTrack) throw new Error('No audio track in WebM audio stream');

  log(`Video: ${vTrack.codecId} ${vTrack.video?.width}x${vTrack.video?.height}`);
  log(`Audio: ${aTrack.codecId} ${aTrack.audio?.samplingFrequency}Hz ch=${aTrack.audio?.channels}`);

  progress('Rebuilding clusters…');
  const vClusters = ebmlRebuildClusters(vInfo, vTrack.origNum, 1);
  const aClusters = ebmlRebuildClusters(aInfo, aTrack.origNum, 2);

  progress('Assembling MKV…');

  const ebmlHeader = ebmlEl(EBML_ID.EBML,
    ebmlEl(0x4286, ebmlEncUint(1)),
    ebmlEl(0x42F7, ebmlEncUint(1)),
    ebmlEl(0x42F2, ebmlEncUint(4)),
    ebmlEl(0x42F3, ebmlEncUint(8)),
    ebmlEl(0x4282, new TextEncoder().encode('matroska')),
    ebmlEl(0x4287, ebmlEncUint(4)),
    ebmlEl(0x4285, ebmlEncUint(2)),
  );

  const segInfo = ebmlEl(EBML_ID.Info,
    ebmlEl(EBML_ID.TimecodeScale, ebmlEncUint(vInfo.timecodeScale)),
    ebmlEl(0x4D80, new TextEncoder().encode('yt-browser-downloader')),
    ebmlEl(0x5741, new TextEncoder().encode('yt-browser-downloader')),
  );

  const tracks = ebmlEl(EBML_ID.Tracks,
    ebmlBuildTrackEntry(vTrack, 1),
    ebmlBuildTrackEntry(aTrack, 2),
  );

  const allClusters = ebmlConcatU8(...vClusters, ...aClusters);
  const segPayload  = ebmlConcatU8(segInfo, tracks, allClusters);
  const segHeader   = ebmlConcatU8(
    ebmlEncId(EBML_ID.Segment),
    new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), // unknown size
  );

  const merged = ebmlConcatU8(ebmlHeader, segHeader, segPayload);
  log(`Merged MKV: ${formatBytes(merged.byteLength)}`);
  return new Blob([merged], { type: 'video/x-matroska' });
}

function canMuxWebmPair() { return true; }

// ─── Fetch ────────────────────────────────────────────────────────────────────

const RANGE_CHUNK_SIZE = 4 * 1024 * 1024;
const RANGE_PARALLELISM = 4;

function updateKindProgress(kind, loaded, total = 0) {
  transferProgress[kind] = { loaded, total };
  reportCombinedProgress();
}

async function safeHead(url, signal) {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'omit', signal });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

function supportsRangesFromHeaders(res) {
  const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase();
  const contentEncoding = (res.headers.get('content-encoding') || '').toLowerCase();
  const length = Number(res.headers.get('content-length') || 0);
  return acceptRanges === 'bytes' && !contentEncoding && Number.isFinite(length) && length > 0;
}

async function fetchWholeStream(url, kind, signal) {
  const res = await fetch(url, { credentials: 'omit', signal });
  if (!res.ok) throw new Error(`Failed to fetch ${kind}: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body) {
    const data = new Uint8Array(await res.arrayBuffer());
    updateKindProgress(kind, data.byteLength, total || data.byteLength);
    return data;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      updateKindProgress(kind, loaded, total);
    }
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  updateKindProgress(kind, loaded, total || loaded);
  return out;
}

async function fetchRange(url, start, end, signal) {
  const res = await fetch(url, {
    credentials: 'omit',
    signal,
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (!(res.ok || res.status === 206)) {
    throw new Error(`Range request failed: HTTP ${res.status} for bytes=${start}-${end}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchStreamRanged(url, kind, totalSize, signal) {
  const chunkCount = Math.ceil(totalSize / RANGE_CHUNK_SIZE);
  const chunks = new Array(chunkCount);
  let nextIndex = 0;
  let loaded = 0;

  log(`${kind}: using ranged download (${chunkCount} chunks, ${RANGE_PARALLELISM} workers)`);

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= chunkCount) return;
      const start = index * RANGE_CHUNK_SIZE;
      const end = Math.min(totalSize - 1, start + RANGE_CHUNK_SIZE - 1);
      const chunk = await fetchRange(url, start, end, signal);
      chunks[index] = chunk;
      loaded += chunk.byteLength;
      updateKindProgress(kind, loaded, totalSize);
      log(`${kind}: chunk ${index + 1}/${chunkCount} (${formatBytes(chunk.byteLength)})`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(RANGE_PARALLELISM, chunkCount) }, () => worker()));

  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk) throw new Error(`${kind}: missing ranged chunk during assembly`);
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  updateKindProgress(kind, totalSize, totalSize);
  return out;
}

async function fetchStream(url, kind, signal) {
  updateKindProgress(kind, 0, 0);
  const head = await safeHead(url, signal);
  if (head && supportsRangesFromHeaders(head)) {
    const totalSize = Number(head.headers.get('content-length'));
    log(`${kind}: HEAD ok — size=${formatBytes(totalSize)}, accept-ranges=bytes`);
    try {
      return await fetchStreamRanged(url, kind, totalSize, signal);
    } catch (error) {
      log(`${kind}: ranged download failed, falling back to single fetch (${error?.message || error})`);
    }
  } else {
    log(`${kind}: ranged download unavailable — falling back to single fetch`);
  }
  return await fetchWholeStream(url, kind, signal);
}

// ─── MP4Box merge (plain MP4) ─────────────────────────────────────────────────

let mp4boxLoaded = false;

async function loadMp4box() {
  if (mp4boxLoaded) return;
  importScripts(`${BASE_URL}/mp4box_all_min.js`);
  if (typeof MP4Box === 'undefined') throw new Error('MP4Box failed to load — make sure mp4box_all_min.js is in the extension folder.');
  mp4boxLoaded = true;
}

function toArrayBuffer(u8) {
  // Always produce a fresh, zero-offset ArrayBuffer so MP4Box's DataView
  // arithmetic cannot wander outside the intended byte range.
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

async function muxWithMp4box(vData, aData) {
  return new Promise((resolve, reject) => {
    try {
      const outputFile = MP4Box.createFile();
      let videoTrackId = null;
      let audioTrackId = null;
      let videoSamples = [];
      let audioSamples = [];
      let videoDone = false;
      let audioDone = false;

      function tryFinish() {
        if (!videoDone || !audioDone) return;
        if (!videoSamples.length) { reject(new Error('No video samples extracted')); return; }
        if (!audioSamples.length) { reject(new Error('No audio samples extracted')); return; }

        log(`Samples — video: ${videoSamples.length}, audio: ${audioSamples.length}`);
        progress('Writing output MP4…');

        for (const s of videoSamples) {
          outputFile.addSample(videoTrackId, s.data, {
            duration: s.duration, cts: s.cts, dts: s.dts,
            is_sync: s.is_sync, description_index: s.description_index ?? 0,
          });
        }
        for (const s of audioSamples) {
          outputFile.addSample(audioTrackId, s.data, {
            duration: s.duration, cts: s.cts, dts: s.dts,
            is_sync: s.is_sync, description_index: s.description_index ?? 0,
          });
        }

        try {
          // getBuffer() returns a complete ArrayBuffer of the muxed file.
          // Wrap in try/catch and surface the real error message if it fails.
          const buf = outputFile.getBuffer();
          if (!buf || buf.byteLength === 0) throw new Error('getBuffer returned empty result');
          resolve(new Blob([buf], { type: 'video/mp4' }));
        } catch (e) {
          // Attempt segment-based fallback: collect via onSegment if available.
          try {
            const segments = [];
            outputFile.onSegment = (_id, _user, ab) => { if (ab) segments.push(new Uint8Array(ab)); };
            outputFile.setSegmentOptions(videoTrackId, null, { nbSamples: 100 });
            outputFile.setSegmentOptions(audioTrackId, null, { nbSamples: 100 });
            outputFile.flush();
            if (segments.length) {
              const total = segments.reduce((n, s) => n + s.length, 0);
              const out = new Uint8Array(total); let off = 0;
              for (const s of segments) { out.set(s, off); off += s.length; }
              resolve(new Blob([out], { type: 'video/mp4' }));
              return;
            }
          } catch (_) { /* segment fallback also failed */ }
          reject(new Error(`MP4Box getBuffer failed: ${e?.message || e}`));
        }
      }

      const vFile = MP4Box.createFile();
      vFile.onReady = (info) => {
        const track = info.videoTracks?.[0];
        if (!track) { reject(new Error('No video track in stream')); return; }

        // Resolve the stsd entry using the track index from the public info object
        // so we don't rely on moov?.traks?.[0] which breaks when track IDs != 1.
        const trakIdx = info.tracks.findIndex(t => t.id === track.id);
        const internalTrak = vFile.moov?.traks?.[trakIdx] ?? vFile.moov?.traks?.[0];
        const stsdEntry = internalTrak?.mdia?.minf?.stbl?.stsd?.entries?.[0];

        const isHevc = track.codec?.startsWith('hev') || track.codec?.startsWith('hvc');
        const isAv1  = track.codec?.startsWith('av01') || track.codec?.startsWith('av1');
        let codecType = 'avc1';
        if (isHevc) codecType = 'hvc1';
        else if (isAv1) codecType = 'av01';

        const trackOpts = {
          timescale: track.timescale,
          width:     track.video?.width  || 1920,
          height:    track.video?.height || 1080,
          hdlr:      'vide',
          name:      'VideoHandler',
          type:      codecType,
          language:  track.language || 'und',
        };

        if (stsdEntry?.avcC)      trackOpts.avcDecoderConfigRecord  = stsdEntry.avcC;
        else if (stsdEntry?.hvcC) trackOpts.hevcDecoderConfigRecord = stsdEntry.hvcC;
        else if (stsdEntry?.av1C) trackOpts.av1DecoderConfigRecord  = stsdEntry.av1C;

        log(`Video track: codec=${track.codec} type=${codecType} ${track.video?.width}x${track.video?.height}`);
        videoTrackId = outputFile.addTrack(trackOpts);
        vFile.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        vFile.start();
      };
      vFile.onSamples = (_id, _user, samples) => { videoSamples.push(...samples); };
      vFile.onFlush = () => { videoDone = true; tryFinish(); };
      vFile.onError = (e) => reject(new Error(`Video parse error: ${e}`));

      const aFile = MP4Box.createFile();
      aFile.onReady = (info) => {
        const track = info.audioTracks?.[0];
        if (!track) { reject(new Error('No audio track in stream')); return; }

        const trakIdx = info.tracks.findIndex(t => t.id === track.id);
        const internalTrak = aFile.moov?.traks?.[trakIdx] ?? aFile.moov?.traks?.[0];
        const stsdEntry = internalTrak?.mdia?.minf?.stbl?.stsd?.entries?.[0];

        const audioOpts = {
          timescale:     track.timescale,
          channel_count: track.audio?.channel_count || 2,
          samplerate:    track.audio?.sample_rate    || 44100,
          samplesize:    track.audio?.sample_size    || 16,
          hdlr:          'soun',
          name:          'SoundHandler',
          type:          'mp4a',
          language:      track.language || 'und',
        };

        // Forward the AudioSpecificConfig so the output track is fully initialised.
        if (stsdEntry?.esds) audioOpts.esds = stsdEntry.esds;

        log(`Audio track: codec=${track.codec} ${track.audio?.sample_rate}Hz ch=${track.audio?.channel_count}`);
        audioTrackId = outputFile.addTrack(audioOpts);
        aFile.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        aFile.start();
      };
      aFile.onSamples = (_id, _user, samples) => { audioSamples.push(...samples); };
      aFile.onFlush = () => { audioDone = true; tryFinish(); };
      aFile.onError = (e) => reject(new Error(`Audio parse error: ${e}`));

      const vAB = toArrayBuffer(vData); vAB.fileStart = 0;
      vFile.appendBuffer(vAB); vFile.flush();

      const aAB = toArrayBuffer(aData); aAB.fileStart = 0;
      aFile.appendBuffer(aAB); aFile.flush();

    } catch (err) {
      reject(err);
    }
  });
}

// ─── fMP4 muxer (fragmented MP4 / CMAF) ──────────────────────────────────────

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const strBytes = (s) => s.split('').map((c) => c.charCodeAt(0));
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function wr32(b, o, v) {
  v = v >>> 0;
  b[o] = (v >>> 24) & 0xFF;
  b[o + 1] = (v >>> 16) & 0xFF;
  b[o + 2] = (v >>> 8) & 0xFF;
  b[o + 3] = v & 0xFF;
}

function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total); let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function boxBuild(name, ...p) {
  const pl = concat(...p);
  const b = new Uint8Array(8 + pl.length);
  wr32(b, 0, 8 + pl.length);
  b.set(strBytes(name), 4);
  b.set(pl, 8);
  return b;
}

function fullboxBuild(name, ver, flags, ...p) {
  const pl = concat(...p);
  const b = new Uint8Array(12 + pl.length);
  wr32(b, 0, 12 + pl.length);
  b.set(strBytes(name), 4);
  b[8] = ver;
  b[9] = (flags >>> 16) & 0xFF;
  b[10] = (flags >>> 8) & 0xFF;
  b[11] = flags & 0xFF;
  b.set(pl, 12);
  return b;
}

function num32(v) { const b = new Uint8Array(4); wr32(b, 0, v); return b; }
function zeros(n) { return new Uint8Array(n); }

function parseBoxList(data, start = 0, end = data.length) {
  const boxes = []; let i = start;
  while (i + 8 <= end) {
    let size = u32(data, i);
    const name = fourcc(data, i + 4);
    let dataStart = i + 8;
    if (size === 1) {
      // 64-bit largesize: read hi+lo words. Clamp to buffer end to avoid OOB.
      if (i + 16 > end) break;
      const hi = u32(data, i + 8);
      const lo = u32(data, i + 12);
      // If hi is non-zero the box is >4GB — just consume to end of buffer.
      size = hi === 0 ? lo : (end - i);
      dataStart = i + 16;
    } else if (size === 0) {
      // size=0 means "extends to end of file"
      size = end - i;
    }
    if (size < 8) break;
    boxes.push({ name, start: i, end: i + size, dataStart });
    i += size;
  }
  return boxes;
}

function findBox(data, ds, de, name) {
  return parseBoxList(data, ds, de).find(b => b.name === name) || null;
}

function parseMoov(data) {
  const top = parseBoxList(data);
  const moovBox = top.find(b => b.name === 'moov');
  if (!moovBox) throw new Error('No moov box found in fMP4 stream.');
  const trak = findBox(data, moovBox.dataStart, moovBox.end, 'trak');
  const mdia = findBox(data, trak.dataStart, trak.end, 'mdia');
  const mdhd = findBox(data, mdia.dataStart, mdia.end, 'mdhd');
  const hdlr = findBox(data, mdia.dataStart, mdia.end, 'hdlr');
  const minf = findBox(data, mdia.dataStart, mdia.end, 'minf');
  const stbl = findBox(data, minf.dataStart, minf.end, 'stbl');
  const stsd = findBox(data, stbl.dataStart, stbl.end, 'stsd');
  const mv = data[mdhd.dataStart];
  const ts = mv === 1 ? u32(data, mdhd.dataStart + 20) : u32(data, mdhd.dataStart + 12);
  const dur = mv === 1 ? u32(data, mdhd.dataStart + 24) : u32(data, mdhd.dataStart + 16);
  const ht = fourcc(data, hdlr.dataStart + 8);
  const stsdRaw = data.slice(stsd.start, stsd.end);
  const tkhd = findBox(data, trak.dataStart, trak.end, 'tkhd');
  let w = 0, h = 0;
  if (tkhd) {
    const tv = data[tkhd.dataStart];
    const wo = tv === 1 ? 76 : 60;
    w = u32(data, tkhd.dataStart + wo) >> 16;
    h = u32(data, tkhd.dataStart + wo + 4) >> 16;
  }
  return { timescale: ts, duration: dur, handlerType: ht, stsdRaw, width: w, height: h };
}

function rewriteFragments(data, newId) {
  const frags = [];
  const top = parseBoxList(data);
  for (let i = 0; i < top.length; i++) {
    if (top[i].name !== 'moof') continue;
    const moof = data.slice(top[i].start, top[i].end).slice();
    const traf = parseBoxList(moof, 8, moof.length).find(x => x.name === 'traf');
    if (traf) {
      const tfhd = parseBoxList(moof, traf.dataStart, traf.end).find(x => x.name === 'tfhd');
      if (tfhd) wr32(moof, tfhd.dataStart + 4, newId);
    }
    const next = top[i + 1];
    const mdat = next?.name === 'mdat' ? data.slice(next.start, next.end) : new Uint8Array(0);
    frags.push({ moof: new Uint8Array(moof), mdat });
  }
  return frags;
}

// ─── Plain MP4 → fMP4 normaliser ─────────────────────────────────────────────
//
// YouTube's ANDROID_VR client returns a plain ISO BMFF file (ftyp + moov + mdat).
// muxFmp4() expects fragmented MP4 (moov + moof/mdat pairs). This function
// converts plain MP4 into a single-fragment fMP4 so both paths use the same muxer.
//
// Strategy:
//   1. Find moov and mdat boxes using our pure-JS parser (no DataView, no MP4Box).
//   2. Strip the moov's stts/stsc/stsz/stco sample tables (they become the fragment).
//   3. Emit: ftyp + moov(with mvex/trex) + moof(tfhd/tfdt/trun) + mdat.
//
// If the data is already fMP4 (has moof boxes) it is returned unchanged.
function normaliseToFmp4(data, hint) {
  // Already fragmented — pass through.
  const top = parseBoxList(data);
  if (top.some(b => b.name === 'moof' || b.name === 'styp')) return data;

  const moovBox = top.find(b => b.name === 'moov');
  const mdatBox = top.find(b => b.name === 'mdat');
  if (!moovBox || !mdatBox) {
    // Can't normalise — return as-is and let muxFmp4 throw a clear error.
    return data;
  }

  // ── Parse enough of moov to build moof ──────────────────────────────────────
  const trakBox   = findBox(data, moovBox.dataStart, moovBox.end, 'trak');
  const tkhdBox   = findBox(data, trakBox.dataStart, trakBox.end, 'tkhd');
  const mdiaBox   = findBox(data, trakBox.dataStart, trakBox.end, 'mdia');
  const mdhdBox   = findBox(data, mdiaBox.dataStart, mdiaBox.end, 'mdhd');
  const minfBox   = findBox(data, mdiaBox.dataStart, mdiaBox.end, 'minf');
  const stblBox   = findBox(data, minfBox.dataStart, minfBox.end, 'stbl');

  const mdhdVer   = data[mdhdBox.dataStart];
  const timescale = mdhdVer === 1
    ? u32(data, mdhdBox.dataStart + 20)
    : u32(data, mdhdBox.dataStart + 12);
  const duration  = mdhdVer === 1
    ? u32(data, mdhdBox.dataStart + 24)
    : u32(data, mdhdBox.dataStart + 16);

  // Total sample data size (= mdat payload).
  const mdatPayloadSize = mdatBox.end - mdatBox.dataStart;

  // ── Rebuild moov with mvex (makes it a valid fMP4 init segment) ──────────────
  // We keep the original moov bytes and splice in mvex + strip sample tables
  // so parseMoov() can read the stsd / handler / dimensions.
  // Simpler: clone moov as-is (parseMoov only needs moov; moof carries samples).
  const moovRaw = data.slice(moovBox.start, moovBox.end);

  // Build mvex/trex box to append inside moov.
  const trex = fullboxBuild('trex', 0, 0,
    num32(1),   // track_ID
    num32(1),   // default_sample_description_index
    num32(0),   // default_sample_duration
    num32(0),   // default_sample_size
    num32(0),   // default_sample_flags
  );
  const mvex = boxBuild('mvex', trex);

  // Patch moov size to include mvex.
  const newMoovSize = moovRaw.length + mvex.length;
  const moovPatched = new Uint8Array(newMoovSize);
  moovPatched.set(moovRaw);
  moovPatched.set(mvex, moovRaw.length);
  wr32(moovPatched, 0, newMoovSize);

  // ── Build a single moof covering all sample data ─────────────────────────────
  // tfhd: base-data-offset present (0x000001), default-base-is-moof not set.
  const tfhdFlags = 0x000001; // base-data-offset-present
  // We'll set base-data-offset after we know where mdat starts.
  // For simplicity use default-base-is-moof (0x020000) instead.
  const tfhdFlagsMoof = 0x020000; // default-base-is-moof

  const tfhd = fullboxBuild('tfhd', 0, tfhdFlagsMoof, num32(1));
  const tfdt = fullboxBuild('tfdt', 0, 0, num32(0)); // baseMediaDecodeTime = 0

  // trun: data-offset-present (0x000001) + sample-size-present (0x000200).
  // One sample covering the entire mdat payload.
  const trunFlags = 0x000001 | 0x000200; // data-offset + sample-size
  const dataOffsetPlaceholder = new Uint8Array(4); // filled in below
  const sampleSize = new Uint8Array(4); wr32(sampleSize, 0, mdatPayloadSize);
  const trun = fullboxBuild('trun', 0, trunFlags,
    num32(1),               // sample_count = 1
    dataOffsetPlaceholder,  // data_offset (relative to moof start)
    sampleSize,             // sample_size
  );

  const traf = boxBuild('traf', tfhd, tfdt, trun);
  const moofRaw = boxBuild('moof',
    fullboxBuild('mfhd', 0, 0, num32(1)), // sequence_number = 1
    traf,
  );

  // Fix up data_offset in trun: offset from start of moof to start of mdat payload.
  // data_offset is at: moof(8) + mfhd(16) + traf(8) + tfhd(?) + tfdt(16) + trun(12) + 4(sample_count) = locate it
  // Easier: search for the trun box inside moofRaw and patch offset field.
  const moofArr = new Uint8Array(moofRaw);
  const moofBoxes = parseBoxList(moofArr, 8, moofArr.length); // children of moof
  const trafInMoof = moofBoxes.find(b => b.name === 'traf');
  if (trafInMoof) {
    const trafChildren = parseBoxList(moofArr, trafInMoof.dataStart, trafInMoof.end);
    const trunInMoof = trafChildren.find(b => b.name === 'trun');
    if (trunInMoof) {
      // data_offset is at trunInMoof.dataStart + 4 (version+flags) + 4 (sample_count)
      const doOff = trunInMoof.dataStart + 4 + 4;
      // data_offset = moofRaw.length + 8 (mdat header)
      wr32(moofArr, doOff, moofArr.length + 8);
    }
  }

  // ── Assemble: ftyp + moovPatched + moof + mdat ───────────────────────────────
  const ftyp = boxBuild('ftyp',
    new Uint8Array(strBytes('isom')),
    num32(0),
    new Uint8Array(strBytes('isomiso6avc1dash')),
  );

  const mdatPayload = data.slice(mdatBox.dataStart, mdatBox.end);
  const mdatNew = new Uint8Array(8 + mdatPayload.length);
  wr32(mdatNew, 0, mdatNew.length);
  mdatNew.set(strBytes('mdat'), 4);
  mdatNew.set(mdatPayload, 8);

  return concat(ftyp, moovPatched, moofArr, mdatNew);
}

async function muxFmp4(vData, aData) {
  const vInfo = parseMoov(vData);
  const aInfo = parseMoov(aData);

  function buildTrak(id, ts, dur, ht, stsdRaw, w, h) {
    const isA = ht === 'soun';
    const tkhdP = new Uint8Array(92); let o = 8;
    wr32(tkhdP, o, id); o += 8;
    wr32(tkhdP, o, dur); o += 12;
    if (isA) tkhdP[o] = 0x01;
    o += 4;
    for (const v of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) { wr32(tkhdP, o, v); o += 4; }
    wr32(tkhdP, o, w << 16); o += 4;
    wr32(tkhdP, o, h << 16);
    const tkhd = fullboxBuild('tkhd', 0, 3, tkhdP);
    const mdhdP = new Uint8Array(20); o = 8;
    wr32(mdhdP, o, ts); o += 4;
    wr32(mdhdP, o, dur); o += 4;
    mdhdP[o] = 0x55; mdhdP[o + 1] = 0xC4;
    const mdhd = fullboxBuild('mdhd', 0, 0, mdhdP);
    const hn = isA ? 'SoundHandler\0' : 'VideoHandler\0';
    const hdlrP = new Uint8Array(4 + 4 + 12 + hn.length);
    hdlrP.set(strBytes(ht), 4);
    hdlrP.set(strBytes(hn), 20);
    const hdlr = fullboxBuild('hdlr', 0, 0, hdlrP);
    const mh = isA ? fullboxBuild('smhd', 0, 0, zeros(4)) : fullboxBuild('vmhd', 0, 1, zeros(8));
    const dinf = boxBuild('dinf', fullboxBuild('dref', 0, 0, num32(1), fullboxBuild('url ', 0, 1)));
    const stbl = boxBuild('stbl', stsdRaw,
      fullboxBuild('stts', 0, 0, num32(0)),
      fullboxBuild('stsc', 0, 0, num32(0)),
      fullboxBuild('stsz', 0, 0, zeros(8)),
      fullboxBuild('stco', 0, 0, num32(0)));
    return boxBuild('trak', tkhd, boxBuild('mdia', mdhd, hdlr, boxBuild('minf', mh, dinf, stbl)));
  }

  const p = new Uint8Array(100); let o = 8;
  wr32(p, o, vInfo.timescale); o += 4;
  wr32(p, o, vInfo.duration); o += 4;
  wr32(p, o, 0x00010000); o += 6;
  p[o] = 0x01; o += 12;
  for (const v of [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]) { wr32(p, o, v); o += 4; }
  o += 24; wr32(p, o, 3);

  const moov = boxBuild('moov',
    fullboxBuild('mvhd', 0, 0, p),
    buildTrak(1, vInfo.timescale, vInfo.duration, vInfo.handlerType, vInfo.stsdRaw, vInfo.width, vInfo.height),
    buildTrak(2, aInfo.timescale, aInfo.duration, aInfo.handlerType, aInfo.stsdRaw, 0, 0),
    boxBuild('mvex',
      fullboxBuild('trex', 0, 0, num32(1), num32(1), num32(0), num32(0), num32(0)),
      fullboxBuild('trex', 0, 0, num32(2), num32(1), num32(0), num32(0), num32(0))),
  );

  const ftyp = boxBuild('ftyp',
    new Uint8Array(strBytes('isom')),
    num32(0),
    new Uint8Array(strBytes('isomiso6avc1dash')),
  );

  const vF = rewriteFragments(vData, 1);
  const aF = rewriteFragments(aData, 2);
  const parts = [ftyp, moov];
  for (const f of vF) { parts.push(f.moof); if (f.mdat.length) parts.push(f.mdat); }
  for (const f of aF) { parts.push(f.moof); if (f.mdat.length) parts.push(f.mdat); }
  return new Blob(parts, { type: 'video/mp4' });
}

// ─── EBML read primitives (used for container sniffing) ──────────────────────

function readVint(data, offset) {
  const b0 = data[offset];
  if (b0 & 0x80) return { val: b0 & 0x7F, len: 1 };
  if (b0 & 0x40) return { val: ((b0 & 0x3F) << 8) | data[offset + 1], len: 2 };
  if (b0 & 0x20) return { val: ((b0 & 0x1F) << 16) | (data[offset + 1] << 8) | data[offset + 2], len: 3 };
  if (b0 & 0x10) return { val: ((b0 & 0x0F) << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3], len: 4 };
  throw new Error(`Unsupported VINT at offset ${offset}: 0x${b0.toString(16)}`);
}

function readEbmlId(data, offset) {
  const b0 = data[offset];
  if (b0 & 0x80) return { id: b0, len: 1 };
  if (b0 & 0x40) return { id: (b0 << 8) | data[offset + 1], len: 2 };
  if (b0 & 0x20) return { id: (b0 << 16) | (data[offset + 1] << 8) | data[offset + 2], len: 3 };
  if (b0 & 0x10) return { id: (b0 << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3], len: 4 };
  throw new Error(`Unsupported EBML ID at offset ${offset}: 0x${b0.toString(16)}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeExt(format, ext) {
  if (format === 'audio') return 'm4a';
  const n = String(ext || 'mp4').toLowerCase();
  return ['mp4', 'webm', 'mkv'].includes(n) ? n : 'mp4';
}

function sanitizeFilename(name) {
  return String(name || 'video')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/[\s<>:"/\\|?*'`+\x00-\x1f]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'video';
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
