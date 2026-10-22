import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTopBoxes } from '../src/compressbase-method.js';
import { applyGhostPatch } from '../src/ghost-patch.js';

const ascii = (text) => new TextEncoder().encode(text);
const u32s = (...values) => {
  const bytes = new Uint8Array(4 * values.length);
  values.forEach((value, i) => new DataView(bytes.buffer).setUint32(4 * i, value));
  return bytes;
};

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((offset, part) => {
    out.set(part, offset);
    return offset + part.length;
  }, 0);
  return out;
}

const box = (type, ...payload) => {
  const body = concat(...payload);
  return concat(u32s(8 + body.length), ascii(type), body);
};
const FULL_BOX = u32s(0);
const TIMES = u32s(0x11111111, 0x22222222);
const GHOST = Uint8Array.of(0, 0, 0, 4, 0, 0, 0, 0);

// Media: six 4-byte video samples (two per chunk, one per 1/60 s) and two 4-byte audio samples in
// one chunk (one per 2/60 s), laid out in 0.5 s style blocks like the converter writes.
const VIDEO_CHUNKS = [ascii('AAAABBBB'), ascii('CCCCDDDD'), ascii('EEEEFFFF')];
const AUDIO_CHUNK = ascii('zzzzyyyy');

// 60 fps video: timescale 60, one tick per frame, six frames.
function trak(handler, tables, extraBoxes = []) {
  return box(
    'trak',
    box('tkhd', FULL_BOX, TIMES, new Uint8Array(72)),
    ...extraBoxes,
    box(
      'mdia',
      box('mdhd', FULL_BOX, TIMES, u32s(60, 6), new Uint8Array(4)),
      box('hdlr', FULL_BOX, u32s(0), ascii(handler), new Uint8Array(13)),
      box('minf', box('stbl', ...tables)),
    ),
  );
}

/** A fast-start MP4 like the converter writes; mdat holds video, audio, video, video chunks. */
function buildMp4({ offsetsBox = 'stco', withCtts = false, withEdts = false } = {}) {
  const ftyp = box('ftyp', ascii('isom'), u32s(512), ascii('isomavc1mp41'));
  const moovWith = (videoOffsets, audioOffset) =>
    box(
      'moov',
      box('mvhd', FULL_BOX, TIMES, new Uint8Array(88)),
      trak(
        'vide',
        [
          box('stsd', FULL_BOX, u32s(1, 16), ascii('avc1'), new Uint8Array(8)),
          box('stts', FULL_BOX, u32s(1, 6, 1)),
          ...(withCtts ? [box('ctts', FULL_BOX, u32s(1, 6, 2))] : []),
          box('stsc', FULL_BOX, u32s(1, 1, 2, 1)),
          box('stsz', FULL_BOX, u32s(0, 6, 4, 4, 4, 4, 4, 4)),
          box(offsetsBox, FULL_BOX, u32s(3, ...videoOffsets)),
        ],
        withEdts ? [box('edts', box('elst', FULL_BOX, u32s(1, 6, 1, 0x10000)))] : [],
      ),
      trak('soun', [
        box('stts', FULL_BOX, u32s(1, 2, 2)),
        box('stsc', FULL_BOX, u32s(1, 1, 2, 1)),
        box('stsz', FULL_BOX, u32s(0, 2, 4, 4)),
        box('stco', FULL_BOX, u32s(1, audioOffset)),
      ]),
    );
  const mediaStart = ftyp.length + moovWith([0, 0, 0], 0).length + 8;
  const moov = moovWith([mediaStart, mediaStart + 16, mediaStart + 24], mediaStart + 8);
  return concat(ftyp, moov, box('mdat', VIDEO_CHUNKS[0], AUDIO_CHUNK, VIDEO_CHUNKS[1], VIDEO_CHUNKS[2]));
}

/** Payload of the box along `path`; `nth` picks among same-type boxes at the last step. */
function find(bytes, path, nth = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let matches = 0;
  for (let offset = 0; offset < bytes.length; ) {
    const size = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + size);
    if (type === path[0] && path.length > 1) return find(payload, path.slice(1), nth);
    if (type === path[0] && matches++ === nth) return payload;
    offset += size;
  }
  return null;
}

const words = (payload) =>
  Array.from({ length: payload.length / 4 }, (_, i) => new DataView(payload.buffer, payload.byteOffset).getUint32(4 * i));
const table = (mp4, trakIndex, type) => words(find(find(mp4, ['moov', 'trak'], trakIndex), ['mdia', 'minf', 'stbl', type]));
const decode = (bytes) => new TextDecoder().decode(bytes);

/** Every sample's bytes in sample order, read back through stsc, stco and stsz like a player. */
function samplesOf(mp4, trakIndex) {
  const [, , count, ...sizes] = table(mp4, trakIndex, 'stsz');
  const [, , ...chunkOffsets] = table(mp4, trakIndex, 'stco');
  const [, runCount, ...runs] = table(mp4, trakIndex, 'stsc');
  const samples = [];
  chunkOffsets.forEach((chunkOffset, chunk) => {
    const run = [...Array(runCount).keys()].findLast((r) => runs[3 * r] - 1 <= chunk);
    for (let i = 0, at = chunkOffset; i < runs[3 * run + 1] && samples.length < count; i++) {
      const size = sizes[samples.length];
      samples.push(decode(mp4.subarray(at, at + size)));
      at += size;
    }
  });
  return samples;
}

const patch = async (mp4) => new Uint8Array(await applyGhostPatch(mp4, new Blob([mp4])).arrayBuffer());

test('adds 17/3 ghost samples, one per chunk, after the real video samples', async () => {
  const output = await patch(buildMp4());
  const ghosts = Math.round((6 * 17) / 3);

  const [, , sampleCount, ...sizes] = table(output, 0, 'stsz');
  assert.equal(sampleCount, 6 + ghosts);
  assert.deepEqual(sizes, [4, 4, 4, 4, 4, 4, ...Array(ghosts).fill(8)]);
  const [, chunkCount, ...offsets] = table(output, 0, 'stco');
  const realChunks = chunkCount - ghosts;
  assert.deepEqual(table(output, 0, 'stsc').slice(-3), [realChunks + 1, 1, 1]);
  assert.deepEqual(offsets.slice(realChunks), Array(ghosts).fill(output.length - 8));
  assert.deepEqual(output.subarray(-8), GHOST);
});

test('interleaves audio and video frame by frame in time order, like FFmpeg', async () => {
  const output = await patch(buildMp4());

  assert.equal(decode(find(output, ['mdat']).subarray(0, 32)), 'AAAAzzzzBBBBCCCCyyyyDDDDEEEEFFFF');
});

test('puts video on a 90 kHz clock with a one-tick last frame, so ghosts take almost no time', async () => {
  const output = await patch(buildMp4({ withCtts: true }));

  const mdhd = find(output, ['moov', 'trak', 'mdia', 'mdhd']);
  assert.deepEqual(words(mdhd.subarray(12, 20)), [90_000, 5 * 1500 + 1]);
  assert.deepEqual(table(output, 0, 'stts'), [0, 2, 5, 1500, 1, 1]);
  assert.deepEqual(table(output, 0, 'ctts'), [0, 1, 6, 2 * 1500]);
});

test('reads back every sample with its own bytes, in both tracks', async () => {
  const output = await patch(buildMp4());
  const video = samplesOf(output, 0);

  assert.deepEqual(video.slice(0, 6), ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF']);
  assert.ok(video.slice(6).every((sample) => sample === decode(GHOST)));
  assert.deepEqual(samplesOf(output, 1), ['zzzz', 'yyyy']);
});

test('keeps a video edit list in step with the new clock', async () => {
  const output = await patch(buildMp4({ withEdts: true }));

  assert.deepEqual(words(find(output, ['moov', 'trak', 'edts', 'elst'])), [0, 1, 6, 1500, 0x10000]);
});

test('writes the same header as CompressBase: ffmpeg-style ftyp, a free box, no timestamps', async () => {
  const output = await patch(buildMp4());

  assert.deepEqual(readTopBoxes(output).map((top) => top.name), ['ftyp', 'free', 'moov', 'mdat']);
  assert.deepEqual(find(output, ['ftyp']), concat(ascii('isom'), u32s(512), ascii('isomiso2avc1mp41')));
  assert.deepEqual(find(output, ['moov', 'mvhd']).subarray(4, 12), new Uint8Array(8));
  assert.deepEqual(find(output, ['moov', 'trak', 'tkhd']).subarray(4, 12), new Uint8Array(8));
  assert.deepEqual(find(output, ['moov', 'trak', 'mdia', 'mdhd']).subarray(4, 12), new Uint8Array(8));
});

test('refuses files it cannot patch safely', () => {
  const mp4 = buildMp4();
  const [ftyp, moov, mdat] = readTopBoxes(mp4).map(({ offset, size }) => mp4.subarray(offset, offset + size));

  assert.throws(() => applyGhostPatch(concat(ftyp, mdat, moov), new Blob([mp4])), /fast-start/);
  assert.throws(() => applyGhostPatch(buildMp4({ offsetsBox: 'co64' }), new Blob([mp4])), /stco/);
});
