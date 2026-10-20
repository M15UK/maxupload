import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METHOD_ENDPOINT,
  assemblePatchedFile,
  buildRequest,
  readTopBoxes,
  requestMethodPatch,
} from '../src/compressbase-method.js';

const ascii = (text) => new TextEncoder().encode(text);
const u32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
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

const box = (type, payload) => concat(u32(8 + payload.length), ascii(type), payload);

// ftyp (16) + moov (8 + 12) + mdat (8 + 10): a fast-start MP4 like the converter produces.
const FTYP = box('ftyp', ascii('isomisom'));
const MOOV = box('moov', ascii('old-metadata'));
const MDAT = box('mdat', ascii('MEDIABYTES'));
const MP4 = concat(FTYP, MOOV, MDAT);
const RESOLUTION = { width: 1080, height: 1920 };

/** Builds an API response: 4-byte JSON length, JSON plan, then the binary parts in order. */
function apiResponse(plan, ...parts) {
  const json = ascii(JSON.stringify(plan));
  return concat(u32(json.length), json, ...parts).buffer;
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

test('lists top-level boxes with offsets, sizes and header lengths', () => {
  assert.deepEqual(readTopBoxes(MP4), [
    { name: 'ftyp', offset: 0, size: 16, headerLen: 8, extendsToEnd: false },
    { name: 'moov', offset: 16, size: 20, headerLen: 8, extendsToEnd: false },
    { name: 'mdat', offset: 36, size: 18, headerLen: 8, extendsToEnd: false },
  ]);
});

test('builds the documented request: 4-byte JSON length, manifest, then the moov body', async () => {
  const { manifest, body } = buildRequest(MP4, { postingDevice: 'variant-1', resolution: RESOLUTION });
  const bytes = await bytesOf(body);
  const jsonLength = new DataView(bytes.buffer).getUint32(0);
  const sent = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)));

  assert.deepEqual(sent, manifest);
  assert.deepEqual(manifest, {
    version: 1,
    fileSize: MP4.length,
    topBoxes: readTopBoxes(MP4),
    resolution: RESOLUTION,
    postingDevice: 'variant-1',
  });
  assert.deepEqual(bytes.subarray(4 + jsonLength), ascii('old-metadata'));
});

test('never sends the media payload, only metadata', async () => {
  const { body } = buildRequest(MP4, { postingDevice: 'variant-1', resolution: RESOLUTION });
  const text = new TextDecoder().decode(await bytesOf(body));

  assert.ok(!text.includes('MEDIABYTES'));
});

test('rejects unknown variants and files without exactly one moov', () => {
  assert.throws(() => buildRequest(MP4, { postingDevice: 'variant-9', resolution: RESOLUTION }), /variant/i);
  assert.throws(() => buildRequest(concat(FTYP, MDAT), { postingDevice: 'variant-1', resolution: RESOLUTION }), /moov/i);
});

test('version 4 plan: keeps box order, swaps moov, appends ghost bytes to mdat, then the tail', async () => {
  const { manifest } = buildRequest(MP4, { postingDevice: 'variant-2', resolution: RESOLUTION });
  const newMoov = box('moov', ascii('PATCHED-Patched by Compressbase'));
  const ghost = ascii('GHOST');
  const tail = ascii('TAIL');
  const response = apiResponse(
    { version: 4, ftypLength: 0, moovLength: newMoov.length, ghostLength: ghost.length, tailLength: tail.length, insertFree: false, movedFreeOffset: null },
    newMoov,
    ghost,
    tail,
  );

  const output = await bytesOf(assemblePatchedFile(new Blob([MP4]), manifest, response));

  const expectedMdat = concat(u32(8 + 10 + ghost.length), ascii('mdat'), ascii('MEDIABYTES'), ghost);
  assert.deepEqual(output, concat(FTYP, newMoov, expectedMdat, tail));
});

test('version 4 plan for variant 1 just replaces moov when there are no ghost bytes or tail', async () => {
  const { manifest } = buildRequest(MP4, { postingDevice: 'variant-1', resolution: RESOLUTION });
  const newMoov = box('moov', ascii('PATCHED'));
  const response = apiResponse(
    { version: 4, ftypLength: 0, moovLength: newMoov.length, ghostLength: 0, tailLength: 0, insertFree: false, movedFreeOffset: null },
    newMoov,
  );

  const output = await bytesOf(assemblePatchedFile(new Blob([MP4]), manifest, response));

  assert.deepEqual(output, concat(FTYP, newMoov, MDAT));
});

test('version 2 plan (variant 3): replaces ftyp and moov and inserts a free box after ftyp', async () => {
  const { manifest } = buildRequest(MP4, { postingDevice: 'variant-3', resolution: RESOLUTION });
  const newFtyp = box('ftyp', ascii('mp42mp42'));
  const newMoov = box('moov', ascii('PATCHED'));
  const ghost = ascii('12345678');
  const response = apiResponse(
    { version: 2, ftypLength: newFtyp.length, moovLength: newMoov.length, ghostLength: ghost.length, insertFree: true, movedFreeOffset: null },
    newFtyp,
    newMoov,
    ghost,
  );

  const output = await bytesOf(assemblePatchedFile(new Blob([MP4]), manifest, response));

  const freeBox = new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101]);
  const expectedMdat = concat(u32(8 + 10 + ghost.length), ascii('mdat'), ascii('MEDIABYTES'), ghost);
  assert.deepEqual(output, concat(newFtyp, freeBox, newMoov, expectedMdat));
});

test('rejects malformed API responses', () => {
  const { manifest } = buildRequest(MP4, { postingDevice: 'variant-1', resolution: RESOLUTION });
  const blob = new Blob([MP4]);

  assert.throws(() => assemblePatchedFile(blob, manifest, new Uint8Array(2).buffer), /incomplete/i);
  assert.throws(
    () => assemblePatchedFile(blob, manifest, apiResponse({ version: 9, ftypLength: 0, moovLength: 0, ghostLength: 0 })),
    /invalid patch plan/i,
  );
  assert.throws(
    () => assemblePatchedFile(blob, manifest, apiResponse({ version: 4, ftypLength: 0, moovLength: 99, ghostLength: 0, tailLength: 0 })),
    /invalid patch plan/i,
  );
});

test('posts the request to the documented endpoint without credentials and assembles the reply', async () => {
  const newMoov = box('moov', ascii('PATCHED'));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    const plan = { version: 4, ftypLength: 0, moovLength: newMoov.length, ghostLength: 0, tailLength: 0, insertFree: false, movedFreeOffset: null };
    return new Response(apiResponse(plan, newMoov), { status: 200 });
  };

  const output = await requestMethodPatch(MP4, new Blob([MP4]), {
    postingDevice: 'variant-1',
    resolution: RESOLUTION,
    fetchImpl: fakeFetch,
  });

  assert.equal(calls[0].url, METHOD_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(await bytesOf(output), concat(FTYP, newMoov, MDAT));
});

test('surfaces the API error message when the server refuses the file', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: 'file is above 1080p, pls downscale it' }), { status: 422 });

  await assert.rejects(
    requestMethodPatch(MP4, new Blob([MP4]), { postingDevice: 'variant-1', resolution: RESOLUTION, fetchImpl: fakeFetch }),
    /above 1080p/,
  );
});
