import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/app-error.js';
import {
  COMPRESS_SIZES,
  DEFAULT_SETTINGS,
  ENHANCE_LEVELS,
  MODE_GROUPS,
  SETTING_GROUPS,
  TIKTOK_BITRATE,
  fitResolution,
  planEncode,
  snapFrameRate,
} from '../src/encode-plan.js';

const UHD_120 = { width: 2160, height: 3840, frameRate: 119.88, duration: 30, hasAudio: true };
const FULL_HD_60 = { width: 1080, height: 1920, frameRate: 59.94, duration: 60, hasAudio: true };
const TIKTOK = { ...DEFAULT_SETTINGS, mode: 'tiktok' };
const COMPRESS = { ...DEFAULT_SETTINGS, mode: 'compress' };
const warningCodes = (plan) => plan.warnings.map((warning) => warning.code);

function assertAppError(fn, code) {
  assert.throws(fn, (error) => error instanceof AppError && error.code === code);
}

// ---------- Shared helpers ----------

test('snaps near-standard frame rates to the exact standard value', () => {
  assert.equal(snapFrameRate(119.88), 120);
  assert.equal(snapFrameRate(59.94), 60);
  assert.equal(snapFrameRate(29.97), 30);
  assert.equal(snapFrameRate(23.976), 24);
});

test('does not cap frame rates itself, so "no limit" keeps 240 fps', () => {
  assert.equal(snapFrameRate(239.76), 240);
});

test('rounds odd frame rates and never returns zero', () => {
  assert.equal(snapFrameRate(41.3), 41);
  assert.equal(snapFrameRate(0.3), 1);
});

test('downscales so the short side matches the cap and keeps even dimensions', () => {
  assert.deepEqual(fitResolution(2160, 3840, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(fitResolution(3840, 2160, 720), { width: 1280, height: 720 });
  assert.deepEqual(fitResolution(1081, 1921, 1080), { width: 1080, height: 1920 });
});

test('never upscales, and an unlimited cap keeps the original size', () => {
  assert.deepEqual(fitResolution(720, 1280, 1080), { width: 720, height: 1280 });
  assert.deepEqual(fitResolution(4320, 7680, Infinity), { width: 4320, height: 7680 });
});

test('every setting group lists its choices and each mode shows its own groups', () => {
  assert.deepEqual(SETTING_GROUPS.mode, ['tiktok', 'compress']);
  assert.deepEqual(MODE_GROUPS.tiktok, ['resolution', 'frameRate', 'enhance', 'method']);
  assert.deepEqual(MODE_GROUPS.compress, ['size', 'compressResolution', 'compressFrameRate']);
  Object.entries(DEFAULT_SETTINGS).forEach(([group, value]) => {
    assert.ok(SETTING_GROUPS[group].includes(value), `default ${group}=${value} is not a choice`);
  });
});

// ---------- TikTok mode ----------

test('TikTok defaults use the tested recipe: HEVC 1080p, 60 fps, 7.5 Mbps, patch variant 1', () => {
  const plan = planEncode(UHD_120, TIKTOK);

  assert.equal(plan.mode, 'tiktok');
  assert.equal(plan.codec, 'hevc');
  assert.equal(plan.width, 1080);
  assert.equal(plan.height, 1920);
  assert.equal(plan.frameRate, 60);
  assert.equal(plan.videoBitrate, TIKTOK_BITRATE);
  assert.equal(plan.method, 'variant-1');
  assert.equal(plan.enhance, null);
  assert.equal(plan.audioCopy, true);
});

test('TikTok says when it lowers the frame rate', () => {
  const plan = planEncode(UHD_120, TIKTOK);

  assert.deepEqual(plan.warnings, [{ code: 'fpsCapped', params: { fps: 120, cap: 60 } }]);
});

test('TikTok frame rate choices: up to 120, or keep the original with no limit', () => {
  assert.equal(planEncode(UHD_120, { ...TIKTOK, frameRate: 'max120' }).frameRate, 120);
  assert.equal(planEncode({ ...UHD_120, frameRate: 240 }, { ...TIKTOK, frameRate: 'original' }).frameRate, 240);
  assert.deepEqual(planEncode(UHD_120, { ...TIKTOK, frameRate: 'max120' }).warnings, []);
});

test('TikTok can keep 4K, but then the patch cannot apply and the user is told', () => {
  const plan = planEncode(UHD_120, { ...TIKTOK, resolution: 'original' });

  assert.equal(plan.width, 2160);
  assert.equal(plan.height, 3840);
  assert.equal(plan.method, null);
  assert.ok(warningCodes(plan).includes('methodNeeds1080p'));
  assert.equal(plan.videoBitrate, TIKTOK_BITRATE * 4);
});

test('"Original" resolution keeps up to 8K in both modes', () => {
  const uhd8k = { ...UHD_120, width: 4320, height: 7680 };
  const huge = { ...UHD_120, width: 6000, height: 10000 };

  const tiktok = planEncode(uhd8k, { ...TIKTOK, resolution: 'original' });
  const compress = planEncode(huge, { ...COMPRESS, size: 'best', compressResolution: 'original' });

  assert.deepEqual([tiktok.width, tiktok.height], [4320, 7680]);
  assert.equal(Math.min(compress.width, compress.height), 4320);
});

test('TikTok passes the chosen patch variant through', () => {
  assert.equal(planEncode(UHD_120, { ...TIKTOK, method: 'variant-2' }).method, 'variant-2');
  assert.equal(planEncode(UHD_120, { ...TIKTOK, method: 'variant-3' }).method, 'variant-3');
});

test('TikTok enhancer levels map to shader settings, wider on 4K', () => {
  assert.deepEqual(planEncode(UHD_120, { ...TIKTOK, enhance: 'strong' }).enhance, { ...ENHANCE_LEVELS.strong, radius: 1 });
  assert.equal(planEncode(UHD_120, { ...TIKTOK, enhance: 'natural', resolution: 'original' }).enhance.radius, 2);
});

test('keeps enhancer color changes subtle so TikTok re-encoding does not exaggerate them', () => {
  [ENHANCE_LEVELS.natural, ENHANCE_LEVELS.strong].forEach((level) => {
    assert.ok(level.vibrance <= 0.3);
    assert.ok(level.contrast <= 0.1);
  });
});

// ---------- Compress mode ----------

test('Compress uses H.264 with no TikTok patch and no enhancer', () => {
  const plan = planEncode(FULL_HD_60, COMPRESS);

  assert.equal(plan.mode, 'compress');
  assert.equal(plan.codec, 'avc');
  assert.equal(plan.method, null);
  assert.equal(plan.enhance, null);
});

test('Compress fits the file inside the chosen size', () => {
  Object.entries(COMPRESS_SIZES)
    .filter(([, bytes]) => bytes !== null)
    .forEach(([size, bytes]) => {
      const plan = planEncode(FULL_HD_60, { ...COMPRESS, size });
      assert.ok(plan.estimatedBytes <= bytes, `${size}: ${plan.estimatedBytes} > ${bytes}`);
    });
});

test('Compress re-encodes audio smaller when there is a size limit, and copies it for best quality', () => {
  const small = planEncode(FULL_HD_60, { ...COMPRESS, size: 'small' });
  const best = planEncode(FULL_HD_60, { ...COMPRESS, size: 'best' });

  assert.equal(small.audioCopy, false);
  assert.ok(small.audioBitrate < best.audioBitrate);
  assert.equal(best.audioCopy, true);
});

test('Compress resolution and frame rate choices', () => {
  const at720 = planEncode(UHD_120, { ...COMPRESS, compressResolution: '720p', compressFrameRate: 'max30' });
  const original = planEncode(UHD_120, { ...COMPRESS, size: 'best', compressResolution: 'original', compressFrameRate: 'original' });

  assert.deepEqual([at720.width, at720.height, at720.frameRate], [720, 1280, 30]);
  assert.deepEqual([original.width, original.height, original.frameRate], [2160, 3840, 120]);
});

test('Compress warns when the size is too small for good quality', () => {
  const plan = planEncode({ ...UHD_120, duration: 120 }, { ...COMPRESS, size: 'small', compressResolution: 'original' });

  assert.ok(warningCodes(plan).includes('lowQuality'));
});

test('throws tooLong when a video cannot fit the size at all', () => {
  assertAppError(() => planEncode({ ...FULL_HD_60, duration: 3600 }, { ...COMPRESS, size: 'small' }), 'tooLong');
});

// ---------- Both modes ----------

test('warns when the source is HDR', () => {
  assert.ok(warningCodes(planEncode({ ...UHD_120, isHdr: true }, TIKTOK)).includes('hdrSource'));
});

test('drops the audio budget for silent videos', () => {
  assert.equal(planEncode({ ...UHD_120, hasAudio: false }, TIKTOK).audioBitrate, 0);
});

test('rejects invalid source metadata with specific codes', () => {
  assertAppError(() => planEncode({ ...UHD_120, width: 0 }, TIKTOK), 'invalidDimensions');
  assertAppError(() => planEncode({ ...UHD_120, duration: NaN }, TIKTOK), 'invalidDuration');
  assertAppError(() => planEncode({ ...UHD_120, frameRate: 0 }, TIKTOK), 'invalidFrameRate');
});

test('rejects unknown settings', () => {
  assertAppError(() => planEncode(UHD_120, { ...TIKTOK, mode: 'youtube' }), 'unknownSetting');
  assertAppError(() => planEncode(UHD_120, { ...TIKTOK, frameRate: 'max999' }), 'unknownSetting');
  assertAppError(() => planEncode(UHD_120, { ...COMPRESS, size: 'huge' }), 'unknownSetting');
});
