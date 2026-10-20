// Client for CompressBase's free Method API (https://compressbase.com/method-api), written from its
// published protocol and helper code. Only MP4 metadata is sent (the moov box plus the top-level box
// layout); video and audio never leave the device.
//
// The API's public terms ask for a visible "Powered by CompressBase" credit; the site owner has the
// CompressBase owner's permission to omit it for this non-commercial site. The "Patched by Compressbase"
// comment stays in the output: it is inside the moov the API returns, which is inserted unchanged.

export const METHOD_ENDPOINT = 'https://compressbase.com/api/method/v1/patch';
export const METHOD_VARIANTS = Object.freeze(['variant-1', 'variant-2', 'variant-3']);

const BOX_HEADER_SIZE = 8;
const LARGE_BOX_HEADER_SIZE = 16;
const MAX_TOP_BOXES = 128;
const MAX_MOOV_BODY_BYTES = 10 * 1024 ** 2;
const MAX_PLAN_JSON_BYTES = 65_536;
const MAX_TAIL_BYTES = 4096;
const MAX_U32 = 0xffffffff;
const SUPPORTED_PLAN_VERSIONS = [2, 3, 4];
const FREE_BOX = Object.freeze([0, 0, 0, 8, 102, 114, 101, 101]); // empty 8-byte 'free' box
const UNSUPPORTED_LAYOUT_BOXES = ['moof', 'mfra', 'sidx'];

/**
 * @typedef {{ name: string, offset: number, size: number, headerLen: number, extendsToEnd: boolean }} TopBox
 * @typedef {{ version: 1, fileSize: number, topBoxes: TopBox[], resolution: { width: number, height: number }, postingDevice: string }} Manifest
 */

const fourCC = (bytes, offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/**
 * Lists the top-level boxes of an in-memory MP4.
 * @param {Uint8Array} bytes
 * @returns {TopBox[]}
 */
export function readTopBoxes(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + BOX_HEADER_SIZE > bytes.length) throw new Error('Invalid MP4 layout.');
    let size = view.getUint32(offset);
    let headerLen = BOX_HEADER_SIZE;
    const extendsToEnd = size === 0;
    if (size === 1) {
      if (offset + LARGE_BOX_HEADER_SIZE > bytes.length) throw new Error('Truncated MP4.');
      size = Number(view.getBigUint64(offset + BOX_HEADER_SIZE));
      headerLen = LARGE_BOX_HEADER_SIZE;
    } else if (extendsToEnd) {
      size = bytes.length - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerLen || offset + size > bytes.length) {
      throw new Error('Invalid MP4 box size.');
    }
    boxes.push({ name: fourCC(bytes, offset + 4), offset, size, headerLen, extendsToEnd });
    offset += size;
  }
  return boxes;
}

function validateLayout(topBoxes, postingDevice) {
  const moovs = topBoxes.filter((box) => box.name === 'moov');
  const mdats = topBoxes.filter((box) => box.name === 'mdat');
  if (moovs.length !== 1 || mdats.length === 0 || topBoxes.length > MAX_TOP_BOXES) {
    throw new Error('Use a non-fragmented MP4 with one moov box and at least one mdat box.');
  }
  if (topBoxes.some((box) => UNSUPPORTED_LAYOUT_BOXES.includes(box.name))) {
    throw new Error('Fragmented MP4 files are not supported.');
  }
  // Variants 2 and 3 need a single media box; variant 3 also needs fast start with mdat last.
  if (postingDevice !== 'variant-1' && mdats.length !== 1) throw new Error('This variant needs a single mdat box.');
  const moovIndex = topBoxes.indexOf(moovs[0]);
  const mdatIndex = topBoxes.indexOf(mdats[0]);
  if (postingDevice === 'variant-3' && (moovIndex > mdatIndex || topBoxes.at(-1).name !== 'mdat')) {
    throw new Error('Variant 3 needs a fast-start MP4.');
  }
  return moovs[0];
}

/**
 * Builds the API request: a 4-byte big-endian JSON length, the JSON manifest, then the moov body.
 * @param {Uint8Array} bytes  The complete MP4.
 * @param {{ postingDevice: string, resolution: { width: number, height: number } }} options
 * @returns {{ manifest: Manifest, body: Blob }}
 */
export function buildRequest(bytes, { postingDevice, resolution }) {
  if (!METHOD_VARIANTS.includes(postingDevice)) throw new Error(`Unknown CompressBase variant: ${postingDevice}`);
  const topBoxes = readTopBoxes(bytes);
  const moov = validateLayout(topBoxes, postingDevice);
  if (moov.size - moov.headerLen > MAX_MOOV_BODY_BYTES) throw new Error('Metadata exceeds 10 MiB.');

  const manifest = { version: 1, fileSize: bytes.length, topBoxes, resolution, postingDevice };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, json.length);
  const moovBody = bytes.subarray(moov.offset + moov.headerLen, moov.offset + moov.size);
  return { manifest, body: new Blob([prefix, json, moovBody], { type: 'application/octet-stream' }) };
}

function parseResponse(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4) throw new Error('Incomplete API response.');
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (jsonLength > MAX_PLAN_JSON_BYTES || jsonLength + 4 > bytes.length) throw new Error('Invalid API response header.');
  const plan = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)));
  const tailLength = plan.version === 4 ? plan.tailLength : 0;
  const sizes = [plan.ftypLength, plan.moovLength, plan.ghostLength, tailLength];
  const isValid =
    SUPPORTED_PLAN_VERSIONS.includes(plan.version) &&
    sizes.every((size) => Number.isSafeInteger(size) && size >= 0) &&
    tailLength <= MAX_TAIL_BYTES &&
    4 + jsonLength + sizes.reduce((sum, size) => sum + size, 0) === bytes.length;
  if (!isValid) throw new Error('Invalid patch plan.');

  let offset = 4 + jsonLength;
  const take = (size) => {
    const part = bytes.subarray(offset, offset + size);
    offset += size;
    return part;
  };
  return { plan, ftyp: take(plan.ftypLength), moov: take(plan.moovLength), ghost: take(plan.ghostLength), tail: take(tailLength) };
}

function boxHeader(name, headerLen, size) {
  const header = new Uint8Array(headerLen);
  const view = new DataView(header.buffer);
  if (headerLen === LARGE_BOX_HEADER_SIZE) {
    view.setUint32(0, 1);
    view.setBigUint64(BOX_HEADER_SIZE, BigInt(size));
  } else {
    if (size > MAX_U32) throw new Error(`${name} box exceeds the 32-bit size limit.`);
    view.setUint32(0, size);
  }
  header.set(Array.from(name, (char) => char.charCodeAt(0)), 4);
  return header;
}

const payloadOf = (file, box) => file.slice(box.offset + box.headerLen, box.offset + box.size);
const wholeBox = (file, box) => file.slice(box.offset, box.offset + box.size);
const hasMovedFree = (plan) => plan.movedFreeOffset !== null && plan.movedFreeOffset !== undefined;

// Version 3: moov moves in front of the media box and the ghost bytes go at the very end.
function assembleCombined(file, manifest, { plan, moov, ghost }) {
  if (plan.ftypLength !== 0 || plan.moovLength < 8 || plan.ghostLength < 40) throw new Error('Invalid combined patch plan.');
  const parts = manifest.topBoxes
    .filter((box) => box.name !== 'moov')
    .flatMap((box) =>
      box.name === 'mdat'
        ? [moov, boxHeader('mdat', box.headerLen, box.size), payloadOf(file, box)]
        : [wholeBox(file, box)],
    );
  return new Blob([...parts, ghost], { type: 'video/mp4' });
}

// Versions 2 and 4: keep box order, replace moov (and ftyp in v2), append ghost bytes to mdat.
function assembleInPlace(file, manifest, { plan, ftyp, moov, ghost, tail }) {
  const parts = manifest.topBoxes.flatMap((box) => {
    if (hasMovedFree(plan) && box.offset === plan.movedFreeOffset) return [];
    if (plan.version === 4 && box.extendsToEnd && box.name !== 'moov' && box.name !== 'mdat') {
      // A size-zero box must not swallow the appended tail, so its size becomes explicit.
      return [boxHeader(box.name, BOX_HEADER_SIZE, box.size), payloadOf(file, box)];
    }
    if (box.name === 'ftyp') {
      const newFtyp = plan.version === 4 ? wholeBox(file, box) : ftyp;
      return plan.insertFree ? [newFtyp, new Uint8Array(FREE_BOX)] : [newFtyp];
    }
    if (box.name === 'moov') return hasMovedFree(plan) ? [new Uint8Array(FREE_BOX), moov] : [moov];
    if (box.name === 'mdat') return [boxHeader('mdat', box.headerLen, box.size + ghost.length), payloadOf(file, box), ghost];
    return [wholeBox(file, box)];
  });
  return new Blob(plan.version === 4 ? [...parts, tail] : parts, { type: 'video/mp4' });
}

/**
 * Combines the API's patch plan with the original file. Media payloads are referenced as Blob
 * slices, so the video data is never copied.
 * @param {Blob} file  The original MP4 that the request was built from.
 * @param {Manifest} manifest
 * @param {ArrayBuffer} buffer  The API response body.
 * @returns {Blob}
 */
export function assemblePatchedFile(file, manifest, buffer) {
  const response = parseResponse(buffer);
  return response.plan.version === 3
    ? assembleCombined(file, manifest, response)
    : assembleInPlace(file, manifest, response);
}

async function readErrorMessage(response) {
  try {
    const body = await response.json();
    return body?.error ?? `Patch failed (${response.status}).`;
  } catch {
    return `Patch failed (${response.status}).`;
  }
}

/**
 * Sends the metadata to CompressBase and returns the patched MP4.
 * @param {Uint8Array} bytes  The complete MP4 (used to read its metadata).
 * @param {Blob} file  The same MP4 as a Blob (used to splice the media without copying it).
 * @param {{ postingDevice: string, resolution: { width: number, height: number }, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Blob>}
 */
export async function requestMethodPatch(bytes, file, { postingDevice, resolution, signal, fetchImpl = fetch }) {
  const { manifest, body } = buildRequest(bytes, { postingDevice, resolution });
  const response = await fetchImpl(METHOD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new Error(await readErrorMessage(response));
  return assemblePatchedFile(file, manifest, await response.arrayBuffer());
}
