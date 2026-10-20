// Display helpers. Decimal units (1 MB = 1,000,000 bytes) match how TikTok states its limits.

const KB = 1e3;
const MB = 1e6;
const GB = 1e9;
const MAX_BASE_NAME_LENGTH = 80;
// Keeps a number and its unit on the same line ("12.5 MB" never wraps as "12.5" / "MB").
const NO_BREAK_SPACE = '\u00A0';

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)}${NO_BREAK_SPACE}GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)}${NO_BREAK_SPACE}MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)}${NO_BREAK_SPACE}KB`;
  return `${bytes}${NO_BREAK_SPACE}B`;
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

/**
 * @param {number} bitsPerSecond
 * @returns {string}
 */
export function formatBitrate(bitsPerSecond) {
  const mbps = bitsPerSecond / MB;
  return `${mbps < 1 ? mbps.toFixed(2) : mbps.toFixed(1)}${NO_BREAK_SPACE}Mbps`;
}

/**
 * Builds a download name from the user's file name, keeping only filesystem-safe characters.
 * @param {string} sourceName
 * @param {string} suffix
 * @returns {string}
 */
export function outputFileName(sourceName, suffix) {
  const baseName = sourceName.split(/[\\/]/).pop() ?? '';
  const dot = baseName.lastIndexOf('.');
  const stem = (dot > 0 ? baseName.slice(0, dot) : baseName)
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, MAX_BASE_NAME_LENGTH);
  return `${stem || 'video'}_${suffix}.mp4`;
}
