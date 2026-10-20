// Language lookup. Message catalogs live in ./messages/; keys must match across languages
// (enforced by tests/i18n.test.js).
import { AppError } from './app-error.js';
import en from './messages/en.js';
import ar from './messages/ar.js';

/** @typedef {'en' | 'ar'} Language */

export const LANGUAGES = Object.freeze({
  en: Object.freeze({ htmlLang: 'en', dir: 'ltr' }),
  ar: Object.freeze({ htmlLang: 'ar-SA', dir: 'rtl' }),
});
export const DEFAULT_LANGUAGE = 'en';
const MESSAGES = Object.freeze({ en, ar });
const PLACEHOLDER = /\{(\w+)\}/g;

// Unicode "first strong isolate" … "pop directional isolate". Wrapping inserted values keeps
// mixed runs such as "13.0 MB" or "1080×1920" in order inside Arabic (RTL) sentences.
const FIRST_STRONG_ISOLATE = '⁨';
const POP_DIRECTIONAL_ISOLATE = '⁩';

/** @returns {value is Language} */
export const isLanguage = (value) => typeof value === 'string' && Object.hasOwn(LANGUAGES, value);

/**
 * Wraps text in a bidi isolate whose direction follows its own first strong character.
 * @param {string} text
 * @returns {string}
 */
export const isolate = (text) => `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`;

/**
 * True when `key` has text in `language` or the English fallback. Used for optional text such as hints.
 * @param {string} language
 * @param {string} key
 * @returns {boolean}
 */
export const hasMessage = (language, key) =>
  Object.hasOwn(MESSAGES[language] ?? {}, key) || Object.hasOwn(MESSAGES[DEFAULT_LANGUAGE], key);

/**
 * Looks up `key` and fills `{name}` placeholders. Values are isolated (as Fluent does by default)
 * so they render correctly in both directions.
 * @param {string} language
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function translate(language, key, params = {}) {
  const template = MESSAGES[language]?.[key] ?? MESSAGES[DEFAULT_LANGUAGE][key] ?? key;
  return template.replace(PLACEHOLDER, (match, name) =>
    Object.hasOwn(params, name) ? isolate(String(params[name])) : match,
  );
}

/**
 * Picks the saved language if valid, else the first supported browser language, else English.
 * @param {unknown} savedLanguage
 * @param {readonly string[]} [preferredLanguages]  Usually `navigator.languages`.
 * @returns {Language}
 */
export function detectLanguage(savedLanguage, preferredLanguages = []) {
  if (isLanguage(savedLanguage)) return savedLanguage;
  const preferred = preferredLanguages.map((tag) => tag.toLowerCase().split('-')[0]).find(isLanguage);
  return preferred ?? DEFAULT_LANGUAGE;
}

/**
 * Turns any thrown value into a message in `language`.
 * @param {string} language
 * @param {unknown} error
 * @param {string} fallbackCode  Error code used for unexpected errors; its message receives `{detail}`.
 * @returns {string}
 */
export function translateError(language, error, fallbackCode) {
  if (error instanceof AppError) return translate(language, `error.${error.code}`, error.params);
  if (error instanceof RangeError && /allocat/i.test(error.message)) return translate(language, 'error.outOfMemory');
  const detail = error instanceof Error ? error.message : String(error);
  return translate(language, `error.${fallbackCode}`, { detail });
}
