/**
 * An error shown to the user. The text is looked up by `code` in the active language
 * (see i18n.js), so the same error reads correctly in English and Arabic.
 */
export class AppError extends Error {
  /**
   * @param {string} code
   * @param {Record<string, string | number>} [params]  Values for the message placeholders.
   */
  constructor(code, params = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.params = Object.freeze({ ...params });
  }
}
