/**
 * dom.js — DOM helpers and formatting utilities
 *
 * XSS-safe escaping, byte/date formatting, media-type detection,
 * filename extraction, and modal open/close.
 */

/**
 * XSS-safe HTML escaping. Use for all user-generated content
 * injected via innerHTML.
 */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a byte count as a human-readable string (e.g. "1.5 MB").
 */
export function fmtBytes(b) {
  if (!b) return '0 B';
  const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}

/**
 * Format a Unix timestamp (seconds) as a localized date/time string.
 */
export function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Check if a MIME type is an image.
 */
export function isImg(t) {
  return t && t.startsWith('image/');
}

/**
 * Check if a MIME type is a video.
 */
export function isVid(t) {
  return t && t.startsWith('video/');
}

/**
 * Check if a MIME type is audio.
 */
export function isAud(t) {
  return t && t.startsWith('audio/');
}

/**
 * Check if a MIME type is text-based (including JSON, XML, JS).
 */
export function isText(t) {
  return t && (
    t.startsWith('text/') ||
    t === 'application/json' ||
    t === 'application/xml' ||
    t === 'application/javascript'
  );
}

/**
 * Extract the filename from a URL, decoding URI components.
 */
export function fname(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return '';
  }
}

/**
 * Show a modal by adding the 'show' class.
 */
export function openModal(id) {
  document.getElementById(id).classList.add('show');
}

/**
 * Hide a modal by removing the 'show' class.
 */
export function closeModal(id) {
  document.getElementById(id).classList.remove('show');
}
