import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/app-error.js';
import { hasMessage, translate, translateError } from '../src/i18n.js';
import en from '../src/messages/en.js';
import { SETTING_GROUPS } from '../src/encode-plan.js';

test('fills placeholders and leaves unknown ones visible', () => {
  assert.equal(translate('unit.fps', { fps: 120 }), '120 fps');
  assert.equal(translate('unit.fps'), '{fps} fps');
});

test('falls back to the key itself for unknown text', () => {
  assert.equal(translate('no.such.key'), 'no.such.key');
});

test('translates app errors by code with their parameters', () => {
  const error = new AppError('cannotEncode', { dimensions: '2160×3840', fps: 120 });

  assert.equal(translateError(error, 'conversionFailed'), translate('error.cannotEncode', error.params));
  assert.match(translateError(error, 'conversionFailed'), /2160×3840/);
});

test('wraps unknown errors in the fallback message with their detail', () => {
  const text = translateError(new Error('decoder exploded'), 'conversionFailed');

  assert.equal(text, translate('error.conversionFailed', { detail: 'decoder exploded' }));
});

test('reports memory allocation failures as out of memory', () => {
  assert.equal(translateError(new RangeError('Array buffer allocation failed'), 'conversionFailed'), en['error.outOfMemory']);
});

test('has a message for every error and warning code the app can produce', () => {
  const codes = [
    'error.notVideo', 'error.noVideoTrack', 'error.unreadable', 'error.cannotEncode', 'error.unknown_source_codec',
    'error.undecodable_source_codec', 'error.no_encodable_target_codec', 'error.notConvertible', 'error.tooLong',
    'error.invalidDimensions', 'error.invalidDuration', 'error.invalidFrameRate', 'error.unknownSetting',
    'error.enhancerUnavailable', 'error.outOfMemory', 'error.conversionFailed', 'error.libraryLoad',
    'warning.fpsCapped', 'warning.lowQuality', 'warning.methodFailed', 'warning.audioDropped',
    'warning.hdrSource', 'error.hevcUnsupported',
  ];
  codes.forEach((key) => assert.ok(Object.hasOwn(en, key), `missing "${key}"`));
});

test('no text uses dashes', () => {
  Object.entries(en).forEach(([key, text]) => {
    assert.doesNotMatch(text, /[–—]| - /, `"${key}" contains a dash`);
  });
});

test('every setting group and option has a short title; hints are optional', () => {
  Object.entries(SETTING_GROUPS).forEach(([group, values]) => {
    assert.ok(Object.hasOwn(en, `settings.${group}`), `missing "settings.${group}"`);
    values.forEach((value) => {
      const title = `${group}.${value}`;
      assert.ok(Object.hasOwn(en, title), `missing "${title}"`);
      assert.ok(en[title].length <= 32, `"${title}" title is too long`);
    });
  });
});

test('has text for every option tag', () => {
  ['recommended', 'new', 'beta', 'optional'].forEach((tag) => {
    assert.ok(Object.hasOwn(en, `tag.${tag}`), `missing "tag.${tag}"`);
  });
});

test('tells whether a message exists, so optional hints can be left out', () => {
  assert.equal(hasMessage('mode.tiktok'), true);
  assert.equal(hasMessage('compressResolution.720p.hint'), false);
});
