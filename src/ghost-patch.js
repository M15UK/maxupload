// Local version of CompressBase's Variant 3 patch ("17/3 ghost ratio"), used for Variant 3 and for
// video above 1080p (which the Method API refuses). The file is rewritten like TikQuality's 4K post,
// which TikTok serves as "original" and phones stream smoothly:
// - after the real video samples come fake 8-byte samples, one per chunk, all pointing at one empty
//   NAL unit at the end, and they take almost no time;
// - audio and video are interleaved frame by frame in time order, as FFmpeg writes them. The
//   converter's 0.5 s blocks (3 MB each at 4K, 40 Mbps) made phones freeze while streaming.
// QuickTime drops such a video track (audio only); browsers and TikTok play it.
import { boxHeader, readTopBoxes } from './compressbase-method.js';

const GHOSTS_PER_SAMPLE = 17 / 3;
// Ghost samples take the last real sample's duration. As in TikQuality's file, that duration becomes
// one tick of a 90 kHz clock, so all ghosts fit in a few milliseconds instead of adding minutes of
// empty video that players and TikTok's uploader choke on.
const GHOST_TIMESCALE = 90_000;
// One 4-byte NAL unit of type 0 ("unspecified"), which decoders skip.
const GHOST_SAMPLE = Uint8Array.of(0, 0, 0, 4, 0, 0, 0, 0);
const FREE_BOX = Uint8Array.of(0, 0, 0, 8, 102, 114, 101, 101);
const FTYP_MINOR_VERSION = 512;
const CONTAINERS = new Set(['moov', 'trak', 'edts', 'mdia', 'minf', 'stbl']);
const MAX_U32 = 0xffffffff;
const MAX_I32 = 0x7fffffff;

const ascii = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const typeAt = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Running totals before each value: [3, 4, 5] becomes [0, 3, 7]. */
function startsOf(values) {
  const starts = new Array(values.length);
  values.reduce((total, value, i) => {
    starts[i] = total;
    return total + value;
  }, 0);
  return starts;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  viewOf(bytes).setUint32(0, value);
  return bytes;
}

/** `count` big-endian 32-bit words starting at `offset`. */
const words = (bytes, offset, count) => Array.from({ length: count }, (_, i) => viewOf(bytes).getUint32(offset + 4 * i));

function concat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((offset, part) => {
    out.set(part, offset);
    return offset + part.length;
  }, 0);
  return out;
}

/** Container boxes get `children`; every other box keeps its `payload` bytes. */
function parseBoxes(bytes) {
  const boxes = [];
  for (let offset = 0; offset < bytes.length; ) {
    const size = offset + 8 <= bytes.length ? viewOf(bytes).getUint32(offset) : 0;
    if (size < 8 || offset + size > bytes.length) throw new Error('Invalid MP4 metadata.');
    const type = typeAt(bytes, offset + 4);
    const payload = bytes.subarray(offset + 8, offset + size);
    boxes.push(CONTAINERS.has(type) ? { type, children: parseBoxes(payload) } : { type, payload });
    offset += size;
  }
  return boxes;
}

function serialize(box) {
  const body = box.children ? concat(box.children.map(serialize)) : box.payload;
  return concat([boxHeader(box.type, 8, 8 + body.length), body]);
}

function child(box, type) {
  const found = box.children.find((candidate) => candidate.type === type);
  if (!found) throw new Error(`MP4 metadata has no ${type} box.`);
  return found;
}

const stblOf = (trak) => child(child(child(trak, 'mdia'), 'minf'), 'stbl');
const handlerOf = (trak) => typeAt(child(child(trak, 'mdia'), 'hdlr').payload, 8);
const timescaleOf = (mdhd) => viewOf(mdhd).getUint32(mdhd[0] === 1 ? 20 : 12);
const entryCount = (payload) => viewOf(payload).getUint32(4);

/** Replaces table payloads anywhere under `box` using `edits[type](payload)`. */
const editTables = (box, edits) =>
  box.children
    ? { ...box, children: box.children.map((inner) => editTables(inner, edits)) }
    : edits[box.type] ? { ...box, payload: edits[box.type](box.payload) } : box;

/** A table box payload: version and flags 0, an entry count, then 32-bit values. */
function tablePayload(count, values) {
  const out = new Uint8Array(8 + 4 * values.length);
  const view = viewOf(out);
  view.setUint32(4, count);
  values.forEach((value, i) => view.setUint32(8 + 4 * i, value));
  return out;
}

/** Each sample of a track: its file offset, size, decode time in seconds and sample description. */
function readSamples(trak) {
  const stbl = stblOf(trak);
  const timescale = timescaleOf(child(child(trak, 'mdia'), 'mdhd').payload);
  const stsz = child(stbl, 'stsz').payload;
  const [fixedSize, sampleCount] = words(stsz, 4, 2);
  const sizes = fixedSize ? Array(sampleCount).fill(fixedSize) : words(stsz, 12, sampleCount);
  const stco = child(stbl, 'stco').payload;
  const chunkOffsets = words(stco, 8, entryCount(stco));
  const stsc = child(stbl, 'stsc').payload;
  const runs = words(stsc, 8, 3 * entryCount(stsc)); // first chunk (1-based), samples per chunk, description
  const offsets = [];
  const descriptions = [];
  for (let chunk = 0, run = 0; chunk < chunkOffsets.length && offsets.length < sampleCount; chunk++) {
    while (3 * (run + 1) < runs.length && runs[3 * (run + 1)] - 1 <= chunk) run++;
    for (let i = 0, at = chunkOffsets[chunk]; i < runs[3 * run + 1] && offsets.length < sampleCount; i++) {
      offsets.push(at);
      descriptions.push(runs[3 * run + 2]);
      at += sizes[offsets.length - 1];
    }
  }
  const stts = child(stbl, 'stts').payload;
  const deltas = words(stts, 8, 2 * entryCount(stts)).flatMap((value, i, all) => (i % 2 ? [] : Array(value).fill(all[i + 1])));
  if (offsets.length !== sampleCount || deltas.length < sampleCount) throw new Error('MP4 sample tables do not match.');
  const times = startsOf(deltas.slice(0, sampleCount)).map((ticks) => ticks / timescale);
  return { sizes, offsets, descriptions, times };
}

/**
 * Puts every sample in decode-time order, as FFmpeg writes files; a run of one track's consecutive
 * samples becomes a chunk. Returns the chunks in file order.
 */
function interleavedChunks(tracks) {
  const order = tracks
    .flatMap(({ times }, track) => times.map((time, index) => ({ track, index, time })))
    .sort((a, b) => a.time - b.time || a.track - b.track);
  const descriptions = tracks.map((track) => track.descriptions);
  const starts = order.flatMap((sample, i) => {
    const previous = order[i - 1];
    const continues =
      previous?.track === sample.track &&
      previous.index + 1 === sample.index &&
      descriptions[sample.track][previous.index] === descriptions[sample.track][sample.index];
    return continues ? [] : [i];
  });
  return starts.map((start, n) => ({
    track: order[start].track,
    first: order[start].index,
    count: (starts[n + 1] ?? order.length) - start,
  }));
}

/** Source byte ranges in new file order, merging ranges that already touch. */
function mediaRanges(tracks, chunks) {
  const ranges = [];
  chunks.forEach(({ track, first, count }) => {
    for (let i = first; i < first + count; i++) {
      const start = tracks[track].offsets[i];
      const end = start + tracks[track].sizes[i];
      const last = ranges.at(-1);
      if (last?.[1] === start) last[1] = end;
      else ranges.push([start, end]);
    }
  });
  return ranges;
}

/** Per track: chunk offsets relative to the start of the media, and stsc runs. */
function chunkTables(tracks, chunks) {
  const chunkBytes = chunks.map(({ track, first, count }) => sum(tracks[track].sizes.slice(first, first + count)));
  const relative = startsOf(chunkBytes);
  return tracks.map(({ descriptions }, track) => {
    const own = chunks.flatMap((chunk, i) => (chunk.track === track ? [{ ...chunk, offset: relative[i] }] : []));
    const runs = own.flatMap(({ first, count }, i) => {
      const previous = own[i - 1];
      const same = previous?.count === count && descriptions[previous.first] === descriptions[first];
      return same ? [] : [[i + 1, count, descriptions[first]]];
    });
    return { offsets: own.map(({ offset }) => offset), runs };
  });
}

function stszWithGhosts(payload, ghostCount) {
  if (viewOf(payload).getUint32(4) !== 0) throw new Error('Video samples must have individual sizes.');
  const out = new Uint8Array(payload.length + 4 * ghostCount);
  out.set(payload);
  const view = viewOf(out);
  view.setUint32(8, view.getUint32(8) + ghostCount);
  for (let i = 0; i < ghostCount; i++) view.setUint32(payload.length + 4 * i, GHOST_SAMPLE.length);
  return out;
}

// The API clears creation and modification times (also hiding when the video was made).
function withoutTimestamps(payload) {
  const out = payload.slice();
  out.fill(0, 4, payload[0] === 1 ? 20 : 12);
  return out;
}
const TIMESTAMP_EDITS = Object.freeze({ mvhd: withoutTimestamps, tkhd: withoutTimestamps, mdhd: withoutTimestamps });

/** Video timing on a ~90 kHz clock with a one-tick last sample; returns new mdhd, stts and ctts payloads. */
function retimedVideo(mdhd, stts, ctts) {
  const isV1 = mdhd[0] === 1;
  const timescale = timescaleOf(mdhd);
  if (timescale === 0) throw new Error('Invalid video timescale.');
  const factor = Math.max(1, Math.round(GHOST_TIMESCALE / timescale));
  const pairs = words(stts, 8, 2 * entryCount(stts));
  const entries = pairs.flatMap((count, i) => (i % 2 || count === 0 ? [] : [[count, pairs[i + 1] * factor]]));
  if (entries.length === 0) throw new Error('Video has no samples.');
  const [lastCount, lastDelta] = entries.at(-1);
  const timed = [...entries.slice(0, -1), ...(lastCount > 1 ? [[lastCount - 1, lastDelta]] : []), [1, 1]];
  const duration = sum(timed.map(([count, delta]) => count * delta));
  if (timescale * factor > MAX_U32 || (!isV1 && duration > MAX_U32)) throw new Error('Video timing out of range.');

  const newMdhd = mdhd.slice();
  viewOf(newMdhd).setUint32(isV1 ? 20 : 12, timescale * factor);
  if (isV1) viewOf(newMdhd).setBigUint64(24, BigInt(duration));
  else viewOf(newMdhd).setUint32(16, duration);
  // Composition offsets are in the same clock; version 1 offsets are signed.
  const newCtts = ctts?.slice();
  for (let i = 0; newCtts && i < entryCount(newCtts); i++) {
    const at = 12 + 8 * i;
    if (newCtts[0] === 1) viewOf(newCtts).setInt32(at, viewOf(newCtts).getInt32(at) * factor);
    else viewOf(newCtts).setUint32(at, viewOf(newCtts).getUint32(at) * factor);
  }
  return { factor, mdhd: newMdhd, stts: tablePayload(timed.length, timed.flat()), ctts: newCtts };
}

// Edit list media times are in the video clock too, so they scale with it (-1 marks an empty edit).
function elstRetimed(payload, factor) {
  const out = payload.slice();
  const view = viewOf(out);
  const isV1 = out[0] === 1;
  for (let i = 0; i < entryCount(out); i++) {
    const at = 8 + (isV1 ? 20 : 12) * i + (isV1 ? 8 : 4);
    const time = isV1 ? view.getBigInt64(at) : view.getInt32(at);
    if (time === -1 || time === -1n) continue;
    if (isV1) view.setBigInt64(at, time * BigInt(factor));
    else if (time * factor > MAX_I32) throw new Error('Video timing out of range.');
    else view.setInt32(at, time * factor);
  }
  return out;
}

/**
 * Applies the Variant 3 ghost patch to a fast-start MP4 (ftyp, moov, mdat) such as the converter
 * writes, and interleaves its media. Media payloads are referenced as Blob slices, never copied.
 * @param {Uint8Array} bytes  The complete MP4 (used to read its metadata).
 * @param {Blob} file  The same MP4 as a Blob.
 * @returns {Blob}
 */
export function applyGhostPatch(bytes, file) {
  const topBoxes = readTopBoxes(bytes);
  if (topBoxes.map((box) => box.name).join() !== 'ftyp,moov,mdat') throw new Error('The ghost patch needs a fast-start MP4.');
  const moovBox = topBoxes[1];
  const moov = parseBoxes(bytes.subarray(moovBox.offset + moovBox.headerLen, moovBox.offset + moovBox.size));
  const traks = moov.filter((box) => box.type === 'trak');
  const videoIndex = traks.findIndex((trak) => handlerOf(trak) === 'vide');
  if (videoIndex < 0) throw new Error('MP4 has no video track.');

  const tracks = traks.map(readSamples); // also requires 32-bit chunk offsets (stco) in every track
  const chunks = interleavedChunks(tracks);
  const tables = chunkTables(tracks, chunks);
  const mediaLength = sum(tracks.map(({ sizes }) => sum(sizes)));
  const video = tracks[videoIndex];
  const ghostCount = Math.round(video.sizes.length * GHOSTS_PER_SAMPLE);
  const videoStbl = stblOf(traks[videoIndex]);
  const timing = retimedVideo(
    child(child(traks[videoIndex], 'mdia'), 'mdhd').payload,
    child(videoStbl, 'stts').payload,
    videoStbl.children.find((box) => box.type === 'ctts')?.payload,
  );
  const sampleEntry = child(videoStbl, 'stsd').payload.subarray(12, 16); // e.g. avc1 or hvc1
  const ftyp = serialize({
    type: 'ftyp',
    payload: concat([ascii('isom'), u32(FTYP_MINOR_VERSION), ascii('isomiso2'), sampleEntry, ascii('mp41')]),
  });

  const editsFor = (track, mediaStart) => {
    if (track < 0) return TIMESTAMP_EDITS;
    const isVideo = track === videoIndex;
    // Ghost chunks hold one sample each, at the very end of the file.
    const ghostRun = isVideo ? [[tables[track].offsets.length + 1, 1, video.descriptions.at(-1)]] : [];
    const ghostOffsets = isVideo ? Array(ghostCount).fill(mediaStart + mediaLength) : [];
    const offsets = [...tables[track].offsets.map((offset) => mediaStart + offset), ...ghostOffsets];
    const runs = [...tables[track].runs, ...ghostRun];
    const layout = {
      ...TIMESTAMP_EDITS,
      stsc: () => tablePayload(runs.length, runs.flat()),
      stco: () => tablePayload(offsets.length, offsets),
    };
    return isVideo
      ? {
          ...layout,
          mdhd: () => withoutTimestamps(timing.mdhd),
          stts: () => timing.stts,
          ctts: () => timing.ctts,
          elst: (payload) => elstRetimed(payload, timing.factor),
          stsz: (payload) => stszWithGhosts(payload, ghostCount),
        }
      : layout;
  };
  const moovFor = (mediaStart) =>
    serialize({ type: 'moov', children: moov.map((box) => editTables(box, editsFor(traks.indexOf(box), mediaStart))) });
  // Offsets don't change the moov's size, so a first pass measures where the media will start.
  const mediaStart = ftyp.length + FREE_BOX.length + moovFor(0).length + 8;
  if (mediaStart + mediaLength + GHOST_SAMPLE.length > MAX_U32) throw new Error('File too large for 32-bit chunk offsets.');
  return new Blob(
    [
      ftyp,
      FREE_BOX,
      moovFor(mediaStart),
      boxHeader('mdat', 8, 8 + mediaLength + GHOST_SAMPLE.length),
      ...mediaRanges(tracks, chunks).map(([start, end]) => file.slice(start, end)),
      GHOST_SAMPLE,
    ],
    { type: 'video/mp4' },
  );
}
