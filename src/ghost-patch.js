// Local version of CompressBase's Variant 3 patch ("17/3 ghost ratio") for video above 1080p, which
// the Method API refuses. Rebuilt from the API's own output, plus the near-zero ghost timing of the
// files TikTok accepted (TikQuality's 4K post, CompressBase Variant 2). Only metadata changes: after
// the real video samples come fake 8-byte samples, one per chunk, all pointing at one empty NAL unit
// at the end. QuickTime drops such a video track (audio only); browsers and TikTok play it.
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
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const MAX_U32 = 0xffffffff;

const ascii = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const typeAt = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function u32(value) {
  const bytes = new Uint8Array(4);
  viewOf(bytes).setUint32(0, value);
  return bytes;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
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

/** Replaces table payloads anywhere under `box` using `edits[type](payload)`. */
const editTables = (box, edits) =>
  box.children
    ? { ...box, children: box.children.map((inner) => editTables(inner, edits)) }
    : edits[box.type] ? { ...box, payload: edits[box.type](box.payload) } : box;

/** Copies a table and raises its entry count by `extra`; new entries go at the end. */
function grownTable(payload, countOffset, entrySize, extra) {
  const out = new Uint8Array(payload.length + extra * entrySize);
  out.set(payload);
  const view = viewOf(out);
  const count = view.getUint32(countOffset);
  view.setUint32(countOffset, count + extra);
  return { view, count, out };
}

function stszWithGhosts(payload, ghostCount) {
  if (viewOf(payload).getUint32(4) !== 0) throw new Error('Video samples must have individual sizes.');
  const { view, out } = grownTable(payload, 8, 4, ghostCount);
  for (let i = 0; i < ghostCount; i++) view.setUint32(payload.length + 4 * i, GHOST_SAMPLE.length);
  return out;
}

// Ghost chunks hold one sample each and reuse the last entry's sample description.
function stscWithGhostChunks(payload, firstGhostChunk) {
  const { view, count, out } = grownTable(payload, 4, 12, 1);
  const description = view.getUint32(4 + 12 * count);
  [firstGhostChunk, 1, description].forEach((value, i) => view.setUint32(payload.length + 4 * i, value));
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
  const timescale = viewOf(mdhd).getUint32(isV1 ? 20 : 12);
  if (timescale === 0) throw new Error('Invalid video timescale.');
  const factor = Math.max(1, Math.round(GHOST_TIMESCALE / timescale));
  const entries = Array.from({ length: viewOf(stts).getUint32(4) }, (_, i) => [
    viewOf(stts).getUint32(8 + 8 * i),
    viewOf(stts).getUint32(12 + 8 * i) * factor,
  ]).filter(([count]) => count > 0);
  if (entries.length === 0) throw new Error('Video has no samples.');
  const [lastCount, lastDelta] = entries.at(-1);
  const timed = [...entries.slice(0, -1), ...(lastCount > 1 ? [[lastCount - 1, lastDelta]] : []), [1, 1]];
  const duration = timed.reduce((sum, [count, delta]) => sum + count * delta, 0);
  if (timescale * factor > MAX_U32 || (!isV1 && duration > MAX_U32)) throw new Error('Video timing out of range.');

  const newMdhd = mdhd.slice();
  viewOf(newMdhd).setUint32(isV1 ? 20 : 12, timescale * factor);
  if (isV1) viewOf(newMdhd).setBigUint64(24, BigInt(duration));
  else viewOf(newMdhd).setUint32(16, duration);
  const newStts = concat([stts.subarray(0, 4), u32(timed.length), ...timed.map(([count, delta]) => concat([u32(count), u32(delta)]))]);
  // Composition offsets are in the same clock; version 1 offsets are signed.
  const newCtts = ctts?.slice();
  for (let i = 0; newCtts && i < viewOf(newCtts).getUint32(4); i++) {
    const at = 12 + 8 * i;
    if (newCtts[0] === 1) viewOf(newCtts).setInt32(at, viewOf(newCtts).getInt32(at) * factor);
    else viewOf(newCtts).setUint32(at, viewOf(newCtts).getUint32(at) * factor);
  }
  return { mdhd: newMdhd, stts: newStts, ctts: newCtts };
}

function stcoShifted(payload, shift, ghostCount = 0, ghostOffset = 0) {
  if (ghostOffset > MAX_U32) throw new Error('File too large for 32-bit chunk offsets.');
  const { view, count, out } = grownTable(payload, 4, 4, ghostCount);
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(8 + 4 * i) + shift;
    if (offset < 0 || offset > MAX_U32) throw new Error('Chunk offset out of range.');
    view.setUint32(8 + 4 * i, offset);
  }
  for (let i = 0; i < ghostCount; i++) view.setUint32(payload.length + 4 * i, ghostOffset);
  return out;
}

/**
 * Applies the Variant 3 ghost patch to a fast-start MP4 (ftyp, moov, mdat) such as the converter
 * writes. Media payloads are referenced as Blob slices, so the video data is never copied.
 * @param {Uint8Array} bytes  The complete MP4 (used to read its metadata).
 * @param {Blob} file  The same MP4 as a Blob.
 * @returns {Blob}
 */
export function applyGhostPatch(bytes, file) {
  const topBoxes = readTopBoxes(bytes);
  if (topBoxes.map((box) => box.name).join() !== 'ftyp,moov,mdat') throw new Error('The ghost patch needs a fast-start MP4.');
  const [, moovBox, mdat] = topBoxes;
  const moov = parseBoxes(bytes.subarray(moovBox.offset + moovBox.headerLen, moovBox.offset + moovBox.size));
  const traks = moov.filter((box) => box.type === 'trak');
  traks.forEach((trak) => child(stblOf(trak), 'stco')); // 64-bit offsets (co64) are not handled
  const video = traks.find((trak) => handlerOf(trak) === 'vide');
  if (!video) throw new Error('MP4 has no video track.');

  const videoStbl = stblOf(video);
  const sampleCount = viewOf(child(videoStbl, 'stsz').payload).getUint32(8);
  const chunkCount = viewOf(child(videoStbl, 'stco').payload).getUint32(4);
  const ghostCount = Math.round(sampleCount * GHOSTS_PER_SAMPLE);
  const sampleEntry = child(videoStbl, 'stsd').payload.subarray(12, 16); // e.g. avc1 or hvc1
  // An edit list would still be in the old clock; the converter never writes one for video.
  if (video.children.some((box) => box.type === 'edts')) throw new Error('Video edit lists are not supported.');
  const timing = retimedVideo(
    child(child(video, 'mdia'), 'mdhd').payload,
    child(videoStbl, 'stts').payload,
    videoStbl.children.find((box) => box.type === 'ctts')?.payload,
  );
  const ftyp = serialize({
    type: 'ftyp',
    payload: concat([ascii('isom'), u32(FTYP_MINOR_VERSION), ascii('isomiso2'), sampleEntry, ascii('mp41')]),
  });

  const patchMoov = (shift, ghostOffset) =>
    serialize({
      type: 'moov',
      children: moov.map((box) =>
        editTables(
          box,
          box === video
            ? {
                ...TIMESTAMP_EDITS,
                mdhd: () => withoutTimestamps(timing.mdhd),
                stts: () => timing.stts,
                ctts: () => timing.ctts,
                stsz: (p) => stszWithGhosts(p, ghostCount),
                stsc: (p) => stscWithGhostChunks(p, chunkCount + 1),
                stco: (p) => stcoShifted(p, shift, ghostCount, ghostOffset),
              }
            : { ...TIMESTAMP_EDITS, stco: (p) => stcoShifted(p, shift) },
        ),
      ),
    });
  // Offsets don't change the moov's size, so a first pass measures where the media will start.
  const payloadStart = ftyp.length + FREE_BOX.length + patchMoov(0, 0).length + mdat.headerLen;
  const payloadLength = mdat.size - mdat.headerLen;
  const newMoov = patchMoov(payloadStart - (mdat.offset + mdat.headerLen), payloadStart + payloadLength);
  return new Blob(
    [
      ftyp,
      FREE_BOX,
      newMoov,
      boxHeader('mdat', mdat.headerLen, mdat.size + GHOST_SAMPLE.length),
      file.slice(mdat.offset + mdat.headerLen, mdat.offset + mdat.size),
      GHOST_SAMPLE,
    ],
    { type: 'video/mp4' },
  );
}
