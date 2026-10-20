import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBitrate, formatBytes, formatDuration, outputFileName } from '../src/format.js';

// Number and unit are joined by a no-break space (\u00A0) so they never wrap onto separate lines.
test('formats byte counts with decimal units', () => {
  assert.equal(formatBytes(512), '512\u00A0B');
  assert.equal(formatBytes(72_000_000), '72.0\u00A0MB');
  assert.equal(formatBytes(1_500_000_000), '1.50\u00A0GB');
});

test('formats durations as m:ss or h:mm:ss', () => {
  assert.equal(formatDuration(5.4), '0:05');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3725), '1:02:05');
});

test('formats bitrates in Mbps', () => {
  assert.equal(formatBitrate(49_766_400), '49.8\u00A0Mbps');
  assert.equal(formatBitrate(320_000), '0.32\u00A0Mbps');
});

test('builds a safe output file name from the source name', () => {
  assert.equal(outputFileName('My Clip.final.MOV', 'tiktok_1080p120'), 'My Clip.final_tiktok_1080p120.mp4');
  assert.equal(outputFileName('../../evil:name?.mp4', 'normal'), 'evil_name__normal.mp4');
  assert.equal(outputFileName('', 'normal'), 'video_normal.mp4');
});

test('keeps non-Latin letters and strips invisible control characters', () => {
  assert.equal(outputFileName('فيديو رحلة.mp4', 'normal'), 'فيديو رحلة_normal.mp4');
  assert.equal(outputFileName('clip‮gnp.mp4', 'normal'), 'clipgnp_normal.mp4');
});
