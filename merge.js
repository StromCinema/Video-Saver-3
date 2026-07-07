
function cleanFilename(name, fallback = "reddit_video") {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s*\|\s*reddit\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

// merge.js — Self-contained CMAF/fMP4 merge, zero external dependencies.
//
// Reddit CMAF streams are standard fragmented MP4:
//   [ftyp] [moov] [styp] [sidx] [moof][mdat] [moof][mdat] …
//
// To merge video + audio into one valid MP4 we must:
//   1. Parse moov from each file to get codec config, timescale, duration
//   2. Build a new 2-track moov (video track_id=1, audio track_id=2)
//   3. Rewrite every moof fragment: fix track_id and recalculate
//      base_data_offset so sample data still lines up correctly
//   4. Output: [ftyp][moov][moof][mdat][moof][mdat]…  (video frags, then audio frags)

// ─── Byte helpers ──────────────────────────────────────────────────────────────

const u8  = (b, o)       => b[o];
const u16 = (b, o)       => (b[o] << 8 | b[o+1]) >>> 0;
const u32 = (b, o)       => ((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0;

function wr32(b, o, v) {
  v = v >>> 0;
  b[o]   = (v >>> 24) & 0xff;
  b[o+1] = (v >>> 16) & 0xff;
  b[o+2] = (v >>>  8) & 0xff;
  b[o+3] =  v         & 0xff;
}

function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o+1], b[o+2], b[o+3]);
}

function strBytes(s) {
  return s.split("").map(c => c.charCodeAt(0));
}

// Concatenate array of Uint8Arrays
function concat(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Build a box: 4-byte size + 4-byte name + payload
function box(name, ...payloads) {
  const payload = concat(...payloads);
  const b = new Uint8Array(8 + payload.length);
  wr32(b, 0, 8 + payload.length);
  b.set(strBytes(name), 4);
  b.set(payload, 8);
  return b;
}

// Build a fullbox: size + name + version(1) + flags(3) + payload
function fullbox(name, version, flags, ...payloads) {
  const payload = concat(...payloads);
  const b = new Uint8Array(12 + payload.length);
  wr32(b, 0, 12 + payload.length);
  b.set(strBytes(name), 4);
  b[8]  = version;
  b[9]  = (flags >>> 16) & 0xff;
  b[10] = (flags >>>  8) & 0xff;
  b[11] =  flags         & 0xff;
  b.set(payload, 12);
  return b;
}

function num32(v) {
  const b = new Uint8Array(4);
  wr32(b, 0, v);
  return b;
}

function num16(v) {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function zeros(n) { return new Uint8Array(n); }

// ─── MP4 box parser ────────────────────────────────────────────────────────────

// Parse top-level boxes in data[start..end], return [{name, start, end, dataStart}]
function parseBoxList(data, start = 0, end = data.length) {
  const boxes = [];
  let i = start;
  while (i + 8 <= end) {
    let size = u32(data, i);
    const name = fourcc(data, i + 4);
    if (size === 1) {
      // 64-bit size — clamp to remaining (we don't handle >4GB)
      size = end - i;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < 8) break;
    boxes.push({ name, start: i, end: i + size, dataStart: i + 8 });
    i += size;
  }
  return boxes;
}

// Find first child box with given name inside parent box data[parentDataStart..parentEnd]
function findBox(data, parentDataStart, parentEnd, name) {
  const boxes = parseBoxList(data, parentDataStart, parentEnd);
  return boxes.find(b => b.name === name) || null;
}

function findBoxR(data, parentDataStart, parentEnd, ...path) {
  let cur = { dataStart: parentDataStart, end: parentEnd };
  for (const name of path) {
    cur = findBox(data, cur.dataStart, cur.end, name);
    if (!cur) return null;
  }
  return cur;
}

// ─── Parse moov to extract what we need ────────────────────────────────────────

function parseMoov(data) {
  const topBoxes = parseBoxList(data);
  const moovBox  = topBoxes.find(b => b.name === "moov");
  if (!moovBox) throw new Error("No moov box found");

  const trakBox  = findBox(data, moovBox.dataStart, moovBox.end, "trak");
  if (!trakBox)  throw new Error("No trak box in moov");

  const mdiaBox  = findBox(data, trakBox.dataStart, trakBox.end, "mdia");
  const mdhdBox  = findBox(data, mdiaBox.dataStart, mdiaBox.end, "mdhd");
  const hdlrBox  = findBox(data, mdiaBox.dataStart, mdiaBox.end, "hdlr");
  const minfBox  = findBox(data, mdiaBox.dataStart, mdiaBox.end, "minf");
  const stblBox  = findBox(data, minfBox.dataStart, minfBox.end, "stbl");
  const stsdBox  = findBox(data, stblBox.dataStart, stblBox.end, "stsd");

  // mdhd: version(1), flags(3), creation(4/8), modification(4/8), timescale(4), duration(4/8)
  const mdhdVersion = data[mdhdBox.dataStart];
  let timescale, duration;
  if (mdhdVersion === 1) {
    timescale = u32(data, mdhdBox.dataStart + 1 + 3 + 8 + 8);
    duration  = u32(data, mdhdBox.dataStart + 1 + 3 + 8 + 8 + 4);  // high 32 bits ignored
  } else {
    timescale = u32(data, mdhdBox.dataStart + 1 + 3 + 4 + 4);
    duration  = u32(data, mdhdBox.dataStart + 1 + 3 + 4 + 4 + 4);
  }

  // handler type: version(1) flags(3) pre_defined(4) handler_type(4)
  const handlerType = fourcc(data, hdlrBox.dataStart + 1 + 3 + 4);

  // stsd: version(1) flags(3) entry_count(4) then first sample entry
  const stsdDataStart = stsdBox.dataStart;
  // first entry starts at stsdDataStart + 8 (version+flags+count)
  const firstEntryStart = stsdDataStart + 8;
  const firstEntryEnd   = stsdBox.end;

  // Copy the raw stsd box bytes — we'll reuse it verbatim in the output moov
  const stsdRaw = data.slice(stsdBox.start, stsdBox.end);

  // tkhd for width/height (video only)
  const tkhdBox = findBox(data, trakBox.dataStart, trakBox.end, "tkhd");
  let width = 0, height = 0;
  if (tkhdBox) {
    const tkhdVersion = data[tkhdBox.dataStart];
    const whOffset = tkhdVersion === 1 ? (1+3+8+8+4+4+8+36) : (1+3+4+4+4+4+8+36);
    // width and height are 16.16 fixed point
    width  = u32(data, tkhdBox.dataStart + whOffset) >> 16;
    height = u32(data, tkhdBox.dataStart + whOffset + 4) >> 16;
  }

  return { timescale, duration, handlerType, stsdRaw, width, height };
}

// ─── Build output moov ─────────────────────────────────────────────────────────

function buildMvhd(timescale, duration) {
  // version 0, flags 0
  const p = new Uint8Array(4+4+4+4+4+4+2+2+2+2+4+4+4+4+4+36+4);
  let o = 0;
  // creation_time, modification_time = 0
  o += 8;
  wr32(p, o, timescale); o += 4;
  wr32(p, o, duration);  o += 4;
  // rate 1.0 = 0x00010000
  wr32(p, o, 0x00010000); o += 4;
  // volume 1.0 = 0x0100
  p[o] = 0x01; o += 2;
  // reserved 10 bytes
  o += 10;
  // identity matrix
  const matrix = [0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000];
  for (const v of matrix) { wr32(p, o, v); o += 4; }
  // pre-defined 6x4
  o += 24;
  // next_track_id
  wr32(p, o, 3); // we'll have track 1 and 2
  return fullbox("mvhd", 0, 0, p);
}

function buildTkhd(trackId, duration, width, height, isAudio) {
  // flags: track_enabled(1) | track_in_movie(2) | track_in_preview(4) = 3
  const p = new Uint8Array(4+4+4+4+8+4+4+4+2+2+4+4+4+36+4+4);
  let o = 0;
  // creation, modification = 0
  o += 8;
  wr32(p, o, trackId); o += 4;
  o += 4; // reserved
  wr32(p, o, duration); o += 4;
  o += 8; // reserved
  // layer=0, alternate_group=0
  o += 4;
  // volume: audio=0x0100, video=0
  if (isAudio) { p[o] = 0x01; }
  o += 2;
  o += 2; // reserved
  // identity matrix
  const matrix = [0x00010000,0,0, 0,0x00010000,0, 0,0,0x40000000];
  for (const v of matrix) { wr32(p, o, v); o += 4; }
  // width, height (16.16 fixed point)
  wr32(p, o, width  << 16); o += 4;
  wr32(p, o, height << 16); o += 4;
  return fullbox("tkhd", 0, 3, p);
}

function buildMdhd(timescale, duration) {
  const p = new Uint8Array(4+4+4+4+2+2);
  let o = 0;
  o += 8; // creation, modification
  wr32(p, o, timescale); o += 4;
  wr32(p, o, duration);  o += 4;
  // language: 'und' = packed ISO-639
  p[o] = 0x55; p[o+1] = 0xc4; o += 2;
  // pre_defined
  o += 2;
  return fullbox("mdhd", 0, 0, p);
}

function buildHdlr(handlerType) {
  const name = handlerType === "vide" ? "VideoHandler\0" : "SoundHandler\0";
  const p = new Uint8Array(4 + 4 + 12 + name.length);
  let o = 0;
  o += 4; // pre_defined
  p.set(strBytes(handlerType), o); o += 4;
  o += 12; // reserved
  p.set(strBytes(name), o);
  return fullbox("hdlr", 0, 0, p);
}

function buildDref() {
  // one url entry (self-contained)
  const url = fullbox("url ", 0, 1 /* self-contained flag */);
  const inner = new Uint8Array(4);
  wr32(inner, 0, 1); // entry_count = 1
  return fullbox("dref", 0, 0, inner, url);
}

function buildSmhd() {
  return fullbox("smhd", 0, 0, zeros(4));
}

function buildVmhd() {
  return fullbox("vmhd", 0, 1, zeros(8));
}

// Build a minimal stbl pointing to nothing (since we use fragments)
function buildEmptyStbl(stsdRaw) {
  const stts = fullbox("stts", 0, 0, num32(0));           // no entries
  const stsc = fullbox("stsc", 0, 0, num32(0));
  const stsz = fullbox("stsz", 0, 0, zeros(8));           // sample_size=0, count=0
  const stco = fullbox("stco", 0, 0, num32(0));
  return box("stbl", stsdRaw, stts, stsc, stsz, stco);
}

function buildTrak(trackId, timescale, duration, handlerType, stsdRaw, width, height) {
  const isAudio = handlerType === "soun";
  const tkhd = buildTkhd(trackId, duration, width, height, isAudio);
  const mdhd = buildMdhd(timescale, duration);
  const hdlr = buildHdlr(handlerType);
  const mediaHeader = isAudio ? buildSmhd() : buildVmhd();
  const dinf = box("dinf", buildDref());
  const stbl = buildEmptyStbl(stsdRaw);
  const minf = box("minf", mediaHeader, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  return box("trak", tkhd, mdia);
}

function buildMvex(vTimescale, vDuration, aTimescale, aDuration) {
  // trex for each track
  const vTrex = fullbox("trex", 0, 0,
    num32(1), num32(1), num32(0), num32(0), num32(0)); // track_id=1
  const aTrex = fullbox("trex", 0, 0,
    num32(2), num32(1), num32(0), num32(0), num32(0)); // track_id=2
  return box("mvex", vTrex, aTrex);
}

function buildFtyp() {
  return box("ftyp",
    new Uint8Array(strBytes("isom")),  // major brand
    num32(0),                          // minor version
    new Uint8Array(strBytes("isomiso6avc1dash")) // compatible brands
  );
}

function buildMoov(vInfo, aInfo) {
  // Use video duration in movie timescale (just use video timescale for mvhd)
  const mvhd = buildMvhd(vInfo.timescale, vInfo.duration);
  const vTrak = buildTrak(1, vInfo.timescale, vInfo.duration,
    vInfo.handlerType, vInfo.stsdRaw, vInfo.width, vInfo.height);
  const aTrak = buildTrak(2, aInfo.timescale, aInfo.duration,
    aInfo.handlerType, aInfo.stsdRaw, 0, 0);
  const mvex = buildMvex();
  return box("moov", mvhd, vTrak, aTrak, mvex);
}

// ─── Rewrite moof fragments ────────────────────────────────────────────────────
// Each moof has: mfhd (sequence number) + traf (tfhd + tfdt + trun...)
// We need to:
//   a) Fix track_id in tfhd
//   b) Fix base_data_offset in tfhd to point correctly into our output stream

function rewriteFragments(data, newTrackId, baseOffset) {
  const topBoxes = parseBoxList(data);
  const fragments = []; // [{moof: Uint8Array, mdat: Uint8Array}]

  for (let i = 0; i < topBoxes.length; i++) {
    const b = topBoxes[i];
    if (b.name !== "moof") continue;

    // Copy moof bytes so we can patch them
    const moof = data.slice(b.start, b.end).slice(); // mutable copy

    // Find traf inside moof
    const trafStart = 8; // moof data starts after 8-byte header
    const trafBoxes = parseBoxList(moof, trafStart, moof.length);
    const traf = trafBoxes.find(x => x.name === "traf");
    if (!traf) { fragments.push({ moof, mdat: null }); continue; }

    // Find tfhd inside traf
    const tfhdBoxes = parseBoxList(moof, traf.dataStart, traf.end);
    const tfhd = tfhdBoxes.find(x => x.name === "tfhd");
    if (tfhd) {
      // tfhd: version(1) flags(3) track_id(4) [base_data_offset(8)?] ...
      const tfhdData = tfhd.dataStart; // points into moof
      // patch track_id
      wr32(moof, tfhdData + 4, newTrackId);

      // flags indicate presence of optional fields
      const flags = (moof[tfhdData+1] << 16) | (moof[tfhdData+2] << 8) | moof[tfhdData+3];
      if (flags & 0x000001) {
        // base_data_offset present — patch it
        // base_data_offset is a 64-bit value; we only write low 32 bits (files <4GB)
        wr32(moof, tfhdData + 8, 0);
        wr32(moof, tfhdData + 12, baseOffset + fragments.reduce((a, f) => a + f.moof.length + (f.mdat ? f.mdat.length : 0), 0) + moof.length + 8);
      }
    }

    // Grab following mdat
    const nextBox = topBoxes[i + 1];
    const mdat = (nextBox && nextBox.name === "mdat")
      ? data.slice(nextBox.start, nextBox.end)
      : new Uint8Array(0);

    fragments.push({ moof: new Uint8Array(moof), mdat });
  }

  return fragments;
}

// ─── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchStream(url, onStatus) {
  onStatus(`Downloading ${url.split("/").slice(-2).join("/")}…`);
  const res = await fetch(url, {
    credentials: "omit",
    mode: "cors",
    headers: {
      "Origin": "https://www.reddit.com",
      "Referer": "https://www.reddit.com/"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  // Validate it's actually an MP4
  const validBoxes = ["ftyp","moov","moof","mdat","styp","sidx","free","skip"];
  const firstBox = buf.length >= 8 ? fourcc(buf, 4) : "????";
  if (!validBoxes.includes(firstBox)) {
    throw new Error(
      `Not an MP4 (first box: "${firstBox}"). URL expired? Reload Reddit page, play video, Refresh, retry.`
    );
  }
  return buf;
}

// ─── Main mux ─────────────────────────────────────────────────────────────────

async function muxToMp4(videoUrl, audioUrl, title = '', onStatus = () => {}) {
  if (!videoUrl) throw new Error("Missing video URL.");
  if (!audioUrl) throw new Error("Missing audio URL.");

  // 1. Fetch
  const [vData, aData] = await Promise.all([
    fetchStream(videoUrl, onStatus),
    fetchStream(audioUrl, onStatus)
  ]);

  // 2. Parse moov from each
  onStatus("Parsing streams…");
  const vInfo = parseMoov(vData);
  const aInfo = parseMoov(aData);

  // 3. Build ftyp + moov
  onStatus("Building output MP4…");
  const ftyp = buildFtyp();
  const moov = buildMoov(vInfo, aInfo);

  // 4. Rewrite fragments — track_id 1 for video, 2 for audio
  //    base offset = after ftyp + moov
  const headerSize = ftyp.length + moov.length;

  const vFrags = rewriteFragments(vData, 1, headerSize);
  const aFrags = rewriteFragments(vData, 2,  // note: offset will be recalculated below
    headerSize + vFrags.reduce((a, f) => a + f.moof.length + f.mdat.length, 0));

  // Re-extract audio fragments properly
  const aFragsReal = rewriteFragments(aData, 2,
    headerSize + vFrags.reduce((a, f) => a + f.moof.length + f.mdat.length, 0));

  // 5. Assemble output
  onStatus("Assembling…");
  const parts = [ftyp, moov];
  for (const f of vFrags)     { parts.push(f.moof); if (f.mdat) parts.push(f.mdat); }
  for (const f of aFragsReal) { parts.push(f.moof); if (f.mdat) parts.push(f.mdat); }

  const blob = new Blob(parts, { type: "video/mp4" });
  onStatus("Done ✓");
  return { blob, filename: cleanFilename(title, guessName(videoUrl).replace(/\.mp4$/i, '')) + '.mp4' };
}

function guessName(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return (parts.length >= 2 ? parts[parts.length - 2] : "reddit-video") + ".mp4";
  } catch (_) { return "reddit-merged.mp4"; }
}

async function downloadMergedBlob(blob, filename = "reddit-merged.mp4") {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

globalThis.RedditMerge = { muxToMp4, downloadMergedBlob };
