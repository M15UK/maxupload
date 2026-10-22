// Pure encoding decisions: no browser APIs, so this module is unit-tested in Node.
// User-facing text lives in i18n.js; this module only returns codes.
import { AppError } from './app-error.js';
import { METHOD_VARIANTS } from './compressbase-method.js';

/**
 * @typedef {object} SourceInfo
 * @property {number} width      Display width in pixels (after rotation).
 * @property {number} height     Display height in pixels (after rotation).
 * @property {number} frameRate  Average frames per second.
 * @property {number} duration   Seconds.
 * @property {boolean} hasAudio
 * @property {boolean} [isHdr]   True for HDR (HLG/PQ) sources.
 *
 * @typedef {object} EncodeSettings  One value per SETTING_GROUPS key.
 * @property {'tiktok' | 'compress'} mode
 * @property {'1080p' | 'original'} resolution          TikTok mode
 * @property {'max60' | 'max120' | 'original'} frameRate  TikTok mode
 * @property {'off' | 'natural' | 'strong'} enhance      TikTok mode
 * @property {'variant-1' | 'variant-2' | 'variant-3'} method  TikTok mode
 * @property {'small' | 'medium' | 'large' | 'best'} size          Compress mode
 * @property {'original' | '1080p' | '720p'} compressResolution    Compress mode
 * @property {'original' | 'max60' | 'max30'} compressFrameRate    Compress mode
 *
 * @typedef {{ sharpness: number, vibrance: number, contrast: number, hdr: number }} EnhanceLevel  hdr: HDR look strength
 * @typedef {EnhanceLevel & { radius: number }} EnhanceParams  radius: sharpening tap distance in pixels
 * @typedef {{ code: string, params?: Record<string, number> }} PlanWarning
 *
 * @typedef {object} EncodePlan
 * @property {'tiktok' | 'compress'} mode
 * @property {'avc' | 'hevc'} codec
 * @property {number} width
 * @property {number} height
 * @property {number} frameRate        Exact constant output frame rate.
 * @property {number} videoBitrate     Bits per second.
 * @property {number} audioBitrate     Bits per second (0 when there is no audio).
 * @property {boolean} audioCopy       Copy AAC audio untouched instead of re-encoding it.
 * @property {number} estimatedBytes
 * @property {EnhanceParams | null} enhance
 * @property {string | null} method   CompressBase variant to apply, or null.
 * @property {boolean} patchLocally   Apply the method in the browser instead of through the API.
 * @property {number | null} keyFrameInterval  Seconds between key frames, or null for the encoder default.
 * @property {PlanWarning[]} warnings
 */

// Every choice the settings screen offers, by group. The UI renders these and i18n has a title and
// hint for each value; MODE_GROUPS says which groups each mode shows (mode itself is always shown).
export const SETTING_GROUPS = Object.freeze({
  mode: ['tiktok', 'compress'],
  resolution: ['1080p', 'original'],
  frameRate: ['max60', 'max120', 'original'],
  enhance: ['off', 'natural', 'strong'],
  method: METHOD_VARIANTS,
  size: ['small', 'medium', 'large', 'best'],
  compressResolution: ['original', '1080p', '720p'],
  compressFrameRate: ['original', 'max60', 'max30'],
});

export const MODE_GROUPS = Object.freeze({
  tiktok: ['resolution', 'frameRate', 'enhance', 'method'],
  compress: ['size', 'compressResolution', 'compressFrameRate'],
});

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'tiktok',
  resolution: '1080p',
  frameRate: 'max60',
  enhance: 'off',
  method: 'variant-1',
  size: 'medium',
  compressResolution: '1080p',
  compressFrameRate: 'max60',
});

// Short-side caps in pixels. "original" keeps up to 8K (4320 px short side) in both modes.
const MAX_ORIGINAL_SHORT_SIDE = 4320;
const TIKTOK_MAX_SHORT_SIDE = Object.freeze({ '1080p': 1080, original: MAX_ORIGINAL_SHORT_SIDE });
const COMPRESS_MAX_SHORT_SIDE = Object.freeze({ original: MAX_ORIGINAL_SHORT_SIDE, '1080p': 1080, '720p': 720 });
const FRAME_RATE_CAPS = Object.freeze({ max30: 30, max60: 60, max120: 120, original: Infinity });

// Compress size limits in decimal bytes; "best" has no limit beyond what the browser can hold.
export const COMPRESS_SIZES = Object.freeze({ small: 10_000_000, medium: 25_000_000, large: 50_000_000, best: null });

// The encoded file is held in browser memory (plus a Blob copy), so outputs stay under 1 GB.
const MEMORY_SAFE_BYTES = 1_000_000_000;

// Verified on TikTok: HEVC 1080p at 7.5 Mbps plus the CompressBase patch is served as "original".
export const TIKTOK_BITRATE = 7_500_000;
const FULL_HD_PIXELS = 1080 * 1920;
// The CompressBase API refuses video whose short side is above 1080 px. Larger video copies a post
// TikTok serves as "original" 4K (TikQuality's): H.264 at 40 Mbps with the Variant 3 ghost patch,
// which ghost-patch.js applies in the browser.
const METHOD_MAX_SHORT_SIDE = 1080;
export const TIKTOK_4K_BITRATE = 40_000_000;
const UHD_PIXELS = 2160 * 3840;
// Variant 3 always runs locally: the API's version gives ghost frames full frame durations, and
// TikTok refused to publish a file like that.
const LOCAL_PATCH_METHOD = 'variant-3';
// A key frame every second, as in TikQuality's 4K file: a phone that stalls while streaming can
// resume quickly instead of waiting for the next key frame.
const TIKTOK_KEY_FRAME_SECONDS = 1;

// Shader strengths for enhancer.js. Sharpening does most of the work; color and contrast stay subtle
// because TikTok's re-encode and phone screens exaggerate saturation (strong color made skin look orange).
export const ENHANCE_LEVELS = Object.freeze({
  off: null,
  natural: Object.freeze({ sharpness: 0.5, vibrance: 0.15, contrast: 0.04, hdr: 0.5 }),
  strong: Object.freeze({ sharpness: 1, vibrance: 0.3, contrast: 0.08, hdr: 1 }),
});

// Bits per pixel per frame for "best quality" H.264. Generous so sites that re-encode keep detail.
const BITS_PER_PIXEL = 0.2;
export const MAX_VIDEO_BITRATE = 100_000_000;
const HARD_MIN_VIDEO_BITRATE = 300_000;
const LOW_QUALITY_RATIO = 0.35;
// Leaves room for container overhead and encoder rate-control overshoot.
const SIZE_SAFETY_MARGIN = 0.92;
const HIGH_AUDIO_BITRATE = 320_000;
const SMALL_AUDIO_BITRATE = 128_000;

const STANDARD_FRAME_RATES = [24, 25, 30, 48, 50, 60, 90, 120, 240];
const FRAME_RATE_SNAP_TOLERANCE = 0.03;
const TIKTOK_PLAYBACK_SHORT_SIDE = 1080;

const isPositiveFinite = (value) => Number.isFinite(value) && value > 0;
const toEven = (value) => Math.max(2, 2 * Math.round(value / 2));

/**
 * Snaps a measured frame rate (e.g. 119.88) to the constant rate we encode at. Caps are applied by
 * the caller, so "no limit" can keep high frame rates.
 * @param {number} frameRate
 * @returns {number}
 */
export function snapFrameRate(frameRate) {
  const nearest = STANDARD_FRAME_RATES.reduce((best, rate) =>
    Math.abs(rate - frameRate) < Math.abs(best - frameRate) ? rate : best,
  );
  const withinTolerance = Math.abs(nearest - frameRate) / nearest <= FRAME_RATE_SNAP_TOLERANCE;
  return withinTolerance ? nearest : Math.max(1, Math.round(frameRate));
}

/**
 * Scales down (never up) so the short side is at most `maxShortSide`, keeping aspect ratio and even dimensions.
 * @param {number} width
 * @param {number} height
 * @param {number} maxShortSide  Infinity keeps the original size.
 * @returns {{ width: number, height: number }}
 */
export function fitResolution(width, height, maxShortSide) {
  const scale = Math.min(1, maxShortSide / Math.min(width, height));
  return { width: toEven(width * scale), height: toEven(height * scale) };
}

function validateSource(source) {
  if (!isPositiveFinite(source.width) || !isPositiveFinite(source.height)) throw new AppError('invalidDimensions');
  if (!isPositiveFinite(source.duration)) throw new AppError('invalidDuration');
  if (!isPositiveFinite(source.frameRate)) throw new AppError('invalidFrameRate');
}

function validateSettings(settings) {
  Object.entries(SETTING_GROUPS).forEach(([group, choices]) => {
    if (!choices.includes(settings[group])) throw new AppError('unknownSetting', { value: String(settings[group]) });
  });
}

/** Turns a byte budget into a video bitrate, or throws when the video can't fit at all. */
function budgetBitrate(bytes, duration, audioBitrate) {
  const bitrate = Math.floor((bytes * 8 * SIZE_SAFETY_MARGIN) / duration) - audioBitrate;
  if (bitrate < HARD_MIN_VIDEO_BITRATE) throw new AppError('tooLong');
  return bitrate;
}

function frameRateFor(source, cap) {
  const snapped = snapFrameRate(source.frameRate);
  return { frameRate: Math.min(snapped, cap), capped: snapped > cap };
}

function planTikTok(source, settings) {
  const output = fitResolution(source.width, source.height, TIKTOK_MAX_SHORT_SIDE[settings.resolution]);
  const cap = FRAME_RATE_CAPS[settings.frameRate];
  const { frameRate, capped } = frameRateFor(source, cap);
  const audioBitrate = source.hasAudio ? HIGH_AUDIO_BITRATE : 0;
  const pixels = output.width * output.height;
  const isAbove1080p = Math.min(output.width, output.height) > METHOD_MAX_SHORT_SIDE;
  const method = isAbove1080p ? LOCAL_PATCH_METHOD : settings.method;
  // The verified rates are 7.5 Mbps at 1080p and 40 Mbps at 4K; other sizes scale with pixel count.
  const scaled = isAbove1080p
    ? (TIKTOK_4K_BITRATE * pixels) / UHD_PIXELS
    : TIKTOK_BITRATE * Math.max(1, pixels / FULL_HD_PIXELS);
  const wanted = Math.min(MAX_VIDEO_BITRATE, Math.round(scaled));
  const videoBitrate = Math.min(wanted, budgetBitrate(MEMORY_SAFE_BYTES, source.duration, audioBitrate));
  const level = ENHANCE_LEVELS[settings.enhance];
  return {
    ...output,
    codec: isAbove1080p ? 'avc' : 'hevc',
    frameRate,
    videoBitrate,
    audioBitrate,
    audioCopy: true,
    enhance: level && {
      ...level,
      radius: Math.max(1, Math.round(Math.min(output.width, output.height) / TIKTOK_PLAYBACK_SHORT_SIDE)),
    },
    method,
    patchLocally: method === LOCAL_PATCH_METHOD,
    keyFrameInterval: TIKTOK_KEY_FRAME_SECONDS,
    warnings: [capped && { code: 'fpsCapped', params: { fps: snapFrameRate(source.frameRate), cap } }],
  };
}

function planCompress(source, settings) {
  const output = fitResolution(source.width, source.height, COMPRESS_MAX_SHORT_SIDE[settings.compressResolution]);
  const cap = FRAME_RATE_CAPS[settings.compressFrameRate];
  const { frameRate, capped } = frameRateFor(source, cap);
  const sizeLimit = COMPRESS_SIZES[settings.size];
  const audioBitrate = source.hasAudio ? (sizeLimit ? SMALL_AUDIO_BITRATE : HIGH_AUDIO_BITRATE) : 0;
  const bestBitrate = Math.min(MAX_VIDEO_BITRATE, Math.round(output.width * output.height * frameRate * BITS_PER_PIXEL));
  const videoBitrate = Math.min(bestBitrate, budgetBitrate(sizeLimit ?? MEMORY_SAFE_BYTES, source.duration, audioBitrate));
  return {
    ...output,
    codec: 'avc',
    frameRate,
    videoBitrate,
    audioBitrate,
    // With a size limit the audio is re-encoded at a known bitrate so the file reliably fits.
    audioCopy: sizeLimit === null,
    enhance: null,
    method: null,
    patchLocally: false,
    keyFrameInterval: null,
    warnings: [
      capped && { code: 'fpsCapped', params: { fps: snapFrameRate(source.frameRate), cap } },
      videoBitrate < bestBitrate * LOW_QUALITY_RATIO && { code: 'lowQuality' },
    ],
  };
}

/**
 * Decides how to encode a source video for the chosen mode and settings.
 * @param {SourceInfo} source
 * @param {EncodeSettings} settings
 * @returns {EncodePlan}
 */
export function planEncode(source, settings) {
  validateSource(source);
  validateSettings(settings);
  const plan = settings.mode === 'tiktok' ? planTikTok(source, settings) : planCompress(source, settings);
  return {
    ...plan,
    mode: settings.mode,
    estimatedBytes: Math.ceil(((plan.videoBitrate + plan.audioBitrate) * source.duration) / 8),
    warnings: [source.isHdr && { code: 'hdrSource' }, ...plan.warnings].filter(Boolean),
  };
}
