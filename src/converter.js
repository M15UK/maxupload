// Browser-only glue around Mediabunny (WebCodecs). All processing stays on the user's device.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeVideo,
} from 'mediabunny';
import { AppError } from './app-error.js';
import { createEnhancer } from './enhancer.js';
import { requestMethodPatch } from './compressbase-method.js';
import { applyGhostPatch } from './ghost-patch.js';

/** @typedef {import('./encode-plan.js').EncodePlan} EncodePlan */
/** @typedef {import('./encode-plan.js').SourceInfo & { codec: string | null }} ProbedVideo */

const PROBE_PACKET_COUNT = 240;
// H.264 first: it is TikTok's most widely accepted input. HEVC is the fallback.
const VIDEO_CODEC_PREFERENCE = ['avc', 'hevc'];
const CODEC_LABELS = { avc: 'H.264', hevc: 'HEVC (H.265)' };
const MP4_MIME = 'video/mp4';
// Mediabunny discard reasons that have their own translated message (see messages/*.js).
const EXPLAINED_DISCARD_REASONS = new Set([
  'unknown_source_codec',
  'undecodable_source_codec',
  'no_encodable_target_codec',
]);

const openInput = (file) => new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
const describe = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Reads the metadata needed to plan an encode.
 * @param {File} file
 * @returns {Promise<ProbedVideo>}
 */
export async function probeVideo(file) {
  const input = openInput(file);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new AppError('noVideoTrack');
    const [duration, stats, audio, isHdr] = await Promise.all([
      input.computeDuration(),
      video.computePacketStats(PROBE_PACKET_COUNT),
      input.getPrimaryAudioTrack(),
      video.hasHighDynamicRange(),
    ]);
    return {
      width: video.displayWidth,
      height: video.displayHeight,
      frameRate: stats.averagePacketRate,
      duration,
      hasAudio: audio !== null,
      isHdr,
      codec: video.codec,
    };
  } catch (error) {
    throw error instanceof AppError ? error : new AppError('unreadable', { detail: describe(error) });
  } finally {
    input.dispose();
  }
}

/**
 * @param {EncodePlan} plan
 * @returns {Promise<'avc' | 'hevc'>}
 */
async function pickVideoCodec(plan) {
  const options = { width: plan.width, height: plan.height, bitrate: plan.videoBitrate, frameRate: plan.frameRate };
  // The TikTok Original format only makes sense in HEVC, so it never silently falls back to H.264.
  const candidates = plan.codec === 'hevc' ? ['hevc'] : VIDEO_CODEC_PREFERENCE;
  for (const codec of candidates) {
    if (await canEncodeVideo(codec, options)) return codec;
  }
  if (plan.codec === 'hevc') throw new AppError('hevcUnsupported');
  throw new AppError('cannotEncode', { dimensions: `${plan.width}×${plan.height}`, fps: plan.frameRate });
}

function videoOptions(plan, codec, enhancer) {
  const base = {
    codec,
    width: plan.width,
    height: plan.height,
    fit: 'fill',
    frameRate: plan.frameRate,
    quality: new Quality({ bitrate: plan.videoBitrate }),
    allowTransformationMetadata: false,
    forceTranscode: true,
  };
  return enhancer
    ? { ...base, process: enhancer.process, processedWidth: plan.width, processedHeight: plan.height }
    : base;
}

// AAC is copied untouched when the plan allows it (no generation loss); otherwise, or for other
// codecs, audio is re-encoded at the planned bitrate so size limits hold.
const audioOptionsFor = (plan) => (track) =>
  plan.audioCopy && track.codec === 'aac'
    ? { codec: 'aac' }
    : { codec: 'aac', quality: new Quality({ bitrate: plan.audioBitrate }) };

function invalidConversionError(discardedTracks) {
  const videoDiscard = discardedTracks.find(({ track }) => track.isVideoTrack());
  const reason = videoDiscard?.reason;
  return new AppError(EXPLAINED_DISCARD_REASONS.has(reason) ? reason : 'notConvertible');
}

/**
 * Builds the TikTok upload file. Variants 1 and 2 send only the file's metadata to the CompressBase
 * Method API and splice the media back in locally from `previewFile`; Variant 3 (also used for
 * everything above 1080p) is applied in the browser. A failed patch falls back to the normal MP4
 * rather than discarding a finished encode.
 */
async function buildUploadFile(bytes, previewFile, plan, signal) {
  if (!plan.method) return { uploadFile: previewFile, methodApplied: false, methodError: null };
  try {
    const uploadFile = plan.patchLocally
      ? applyGhostPatch(bytes, previewFile)
      : await requestMethodPatch(bytes, previewFile, {
          postingDevice: plan.method,
          resolution: { width: plan.width, height: plan.height },
          signal,
        });
    return { uploadFile, methodApplied: true, methodError: null };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error('Patch failed; offering the normal MP4 instead.', error);
    return { uploadFile: previewFile, methodApplied: false, methodError: describe(error) };
  }
}

/**
 * @typedef {object} ConversionResult
 * @property {Blob} previewFile       Normal MP4 that plays correctly everywhere.
 * @property {Blob} uploadFile        File to upload to TikTok (CompressBase-patched when applied).
 * @property {boolean} methodApplied
 * @property {string | null} methodError  Why the CompressBase method failed, if it did.
 * @property {string} codecLabel
 * @property {boolean} audioDropped
 */

/**
 * Encodes `file` according to `plan`.
 * @param {File} file
 * @param {EncodePlan} plan
 * @param {{ onProgress?: (fraction: number) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<ConversionResult>}
 */
export async function convertVideo(file, plan, { onProgress, signal } = {}) {
  const codec = await pickVideoCodec(plan);
  signal?.throwIfAborted();
  const enhancer = plan.enhance ? createEnhancer({ width: plan.width, height: plan.height, params: plan.enhance }) : null;
  const input = openInput(file);
  const target = new BufferTarget();
  try {
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target }),
      tracks: 'primary',
      video: videoOptions(plan, codec, enhancer),
      audio: plan.audioBitrate > 0 ? audioOptionsFor(plan) : { discard: true },
      // Drop metadata tags (e.g. GPS location): the moov may be sent to the CompressBase API.
      tags: {},
      showWarnings: false,
    });
    if (!conversion.isValid) throw invalidConversionError(conversion.discardedTracks);

    conversion.onProgress = (fraction) => onProgress?.(fraction);
    // No await between this check and the listener, so a Cancel click can't slip through.
    signal?.throwIfAborted();
    signal?.addEventListener('abort', () => conversion.cancel(), { once: true });
    await conversion.execute();

    const bytes = new Uint8Array(target.buffer);
    const previewFile = new Blob([bytes], { type: MP4_MIME });
    return {
      previewFile,
      ...(await buildUploadFile(bytes, previewFile, plan, signal)),
      codecLabel: CODEC_LABELS[codec],
      audioDropped:
        plan.audioBitrate > 0 && conversion.discardedTracks.some(({ track }) => track.isAudioTrack()),
    };
  } finally {
    input.dispose();
    enhancer?.dispose();
  }
}
