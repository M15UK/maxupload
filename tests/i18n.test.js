import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/app-error.js';
import { LANGUAGES, detectLanguage, hasMessage, isolate, translate, translateError } from '../src/i18n.js';
import en from '../src/messages/en.js';
import ar from '../src/messages/ar.js';
import { SETTING_GROUPS } from '../src/encode-plan.js';

const ARABIC_LETTER = /[؀-ۿ]/;
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();

test('English and Arabic define exactly the same message keys', () => {
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
});

test('every Arabic message uses the same placeholders as its English version', () => {
  Object.keys(en).forEach((key) => {
    assert.deepEqual(placeholders(ar[key]), placeholders(en[key]), `placeholder mismatch in "${key}"`);
  });
});

test('every Arabic message is actually written in Arabic', () => {
  // Latin by design: the language button shows the other language's name, and "1080p" is universal.
  const otherLanguageName = new Set(['header.switchLanguage', 'resolution.1080p', 'compressResolution.1080p', 'compressResolution.720p']);
  Object.entries(ar)
    .filter(([key]) => !otherLanguageName.has(key))
    .forEach(([key, text]) => assert.match(text, ARABIC_LETTER, `"${key}" has no Arabic text`));
});

test('Arabic is right-to-left Saudi Arabic and English is left-to-right', () => {
  assert.deepEqual(LANGUAGES.ar, { htmlLang: 'ar-SA', dir: 'rtl' });
  assert.deepEqual(LANGUAGES.en, { htmlLang: 'en', dir: 'ltr' });
});

test('fills placeholders inside direction isolates and leaves unknown ones visible', () => {
  assert.equal(translate('en', 'unit.fps', { fps: 120 }), `${isolate('120')} fps`);
  assert.equal(translate('en', 'unit.fps'), '{fps} fps');
});

test('isolates text so numbers and units keep their order inside Arabic sentences', () => {
  assert.equal(isolate('13.0 MB'), '⁨13.0 MB⁩');
});

test('Arabic labels keep "number unit" pairs in a left-to-right isolate', () => {
  assert.ok(ar['size.small.hint'].includes('⁦10 MB⁩'));
  assert.ok(ar['size.large.hint'].includes('⁦50 MB⁩'));
});

test('falls back to English, then to the key itself', () => {
  assert.equal(translate('xx', 'convert.cancel'), en['convert.cancel']);
  assert.equal(translate('ar', 'no.such.key'), 'no.such.key');
});

test('prefers a saved language, then the browser language, then English', () => {
  assert.equal(detectLanguage('ar', ['en-US']), 'ar');
  assert.equal(detectLanguage('fr', ['ar-SA', 'en']), 'ar');
  assert.equal(detectLanguage(null, ['de-DE', 'en-GB']), 'en');
  assert.equal(detectLanguage(undefined, []), 'en');
});

test('translates app errors by code with their parameters', () => {
  const error = new AppError('cannotEncode', { dimensions: '2160×3840', fps: 120 });

  assert.equal(translateError('en', error, 'conversionFailed'), translate('en', 'error.cannotEncode', error.params));
  assert.match(translateError('ar', error, 'conversionFailed'), /2160×3840/);
});

test('wraps unknown errors in the fallback message with their detail', () => {
  const text = translateError('en', new Error('decoder exploded'), 'conversionFailed');

  assert.equal(text, translate('en', 'error.conversionFailed', { detail: 'decoder exploded' }));
});

test('reports memory allocation failures as out of memory', () => {
  const text = translateError('ar', new RangeError('Array buffer allocation failed'), 'conversionFailed');

  assert.equal(text, ar['error.outOfMemory']);
});

test('has a message for every error and warning code the app can produce', () => {
  const codes = [
    'error.notVideo', 'error.noVideoTrack', 'error.unreadable', 'error.cannotEncode', 'error.unknown_source_codec',
    'error.undecodable_source_codec', 'error.no_encodable_target_codec', 'error.notConvertible', 'error.tooLong',
    'error.invalidDimensions', 'error.invalidDuration', 'error.invalidFrameRate', 'error.unknownSetting',
    'error.enhancerUnavailable', 'error.outOfMemory', 'error.conversionFailed', 'error.libraryLoad',
    'warning.fpsCapped', 'warning.lowQuality', 'warning.methodFailed', 'warning.audioDropped',
    'warning.hdrSource', 'error.hevcUnsupported', 'warning.methodNeeds1080p',
  ];
  codes.forEach((key) => assert.ok(Object.hasOwn(en, key), `missing "${key}"`));
});

test('no text uses dashes', () => {
  [...Object.entries(en), ...Object.entries(ar)].forEach(([key, text]) => {
    assert.doesNotMatch(text, /[\u2013\u2014]| - /, `"${key}" contains a dash`);
  });
});

test('every setting group and option has a short title in both languages; hints are optional', () => {
  Object.entries(SETTING_GROUPS).forEach(([group, values]) => {
    assert.ok(Object.hasOwn(en, `settings.${group}`) && Object.hasOwn(ar, `settings.${group}`), `missing "settings.${group}"`);
    values.forEach((value) => {
      const title = `${group}.${value}`;
      assert.ok(Object.hasOwn(en, title) && Object.hasOwn(ar, title), `missing "${title}"`);
      assert.ok(en[title].length <= 32, `"${title}" title is too long`);
    });
  });
});

test('has text for every option tag', () => {
  ['recommended', 'new', 'beta', 'optional'].forEach((tag) => {
    assert.ok(Object.hasOwn(en, `tag.${tag}`) && Object.hasOwn(ar, `tag.${tag}`), `missing "tag.${tag}"`);
  });
});

test('tells whether a message exists, so optional hints can be left out', () => {
  assert.equal(hasMessage('ar', 'mode.tiktok'), true);
  assert.equal(hasMessage('en', 'compressResolution.720p.hint'), false);
});
