/**
 * An error shown to the user. Its text is looked up by `code` in messages/en.js (see i18n.js).
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
