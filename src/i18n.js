// UI text lookup. All visible text lives in ./messages/en.js.
import { AppError } from './app-error.js';
import messages from './messages/en.js';

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * True when `key` has text. Used for optional text such as hints.
 * @param {string} key
 * @returns {boolean}
 */
export const hasMessage = (key) => Object.hasOwn(messages, key);

/**
 * Looks up `key` and fills `{name}` placeholders. Unknown keys and placeholders stay visible.
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function translate(key, params = {}) {
  const template = messages[key] ?? key;
  return template.replace(PLACEHOLDER, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}

/**
 * Turns any thrown value into a user-facing message.
 * @param {unknown} error
 * @param {string} fallbackCode  Error code used for unexpected errors; its message receives `{detail}`.
 * @returns {string}
 */
export function translateError(error, fallbackCode) {
  if (error instanceof AppError) return translate(`error.${error.code}`, error.params);
  if (error instanceof RangeError && /allocat/i.test(error.message)) return translate('error.outOfMemory');
  const detail = error instanceof Error ? error.message : String(error);
  return translate(`error.${fallbackCode}`, { detail });
}
