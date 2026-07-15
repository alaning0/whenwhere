/**
 * Shared Adapter Utilities
 *
 * Common functions and constants used across all metadata adapters.
 */

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// Supported media extensions
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'];
export const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v'];
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

// How many files each adapter processes concurrently during a scan
export const SCAN_CONCURRENCY = 12;

/** How often adapters publish mid-scan photo batches to the server cache */
export const PARTIAL_PUBLISH_INTERVAL = 250;

/**
 * Publish photos gathered so far during a concurrent scan, sorted by date
 * so the UI timeline/map stay chronological while the scan is in progress.
 * @param {Array} gathered - Photos collected so far
 * @param {number} completed - Files finished so far
 * @param {number} total - Total files to process
 * @param {function|null|undefined} onPartial
 */
export function maybePublishPartial(gathered, completed, total, onPartial) {
  if (!onPartial) return;
  if (completed % PARTIAL_PUBLISH_INTERVAL === 0 || completed === total) {
    onPartial(gathered.slice().sort(comparePhotosByDate));
  }
}

export class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled');
    this.name = 'ScanCancelledError';
  }
}

function throwIfCancelled(isCancelled) {
  if (isCancelled?.()) {
    throw new ScanCancelledError();
  }
}

/**
 * Stable photo id derived from the adapter's unique iteration key.
 * Must be the per-record unique path (media path, .xmp path, .json path) —
 * NOT the resolved media filename, which can collide across sidecars.
 * 12 hex chars (48 bits) keeps collision odds negligible at library scale;
 * shorter would risk duplicate IndexedDB keys on large libraries.
 *
 * @param {string} key - Unique path for this record
 * @returns {string} 12-char hex id, stable across rescans
 */
export function makePhotoId(key) {
  return crypto.createHash('md5').update(String(key)).digest('hex').slice(0, 12);
}

/**
 * Chronological comparator for photo objects. Dates are ISO-8601 strings
 * (lexicographic order == chronological order), with the id as a tiebreak so
 * same-timestamp photos keep a deterministic order across parallel scans.
 */
export function comparePhotosByDate(a, b) {
  if (a.date < b.date) return -1;
  if (a.date > b.date) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Run fn over items with bounded concurrency. Results keep item order.
 *
 * @param {Array} items
 * @param {number} limit - Max concurrent fn invocations
 * @param {function} fn - async (item, index) => result
 * @param {object} [options] - { isCancelled?: () => boolean }
 * @returns {Promise<Array>} results in item order
 */
export async function mapWithConcurrency(items, limit, fn, options = {}) {
  const { isCancelled } = options;
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      throwIfCancelled(isCancelled);
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array(Math.max(1, Math.min(limit, items.length)))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Format date strings for the frontend
 * @param {Date} dateObj - JavaScript Date object
 * @returns {Object} Formatted date strings
 */
export function formatDates(dateObj) {
  return {
    dateFormatted: dateObj.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }),
    dateShort: dateObj.toLocaleDateString('en-US', {
      year: '2-digit',
      month: 'short',
      day: 'numeric'
    }),
    timeFormatted: dateObj.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }),
    timeShort: dateObj.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  };
}

/**
 * Get file stats for date fallback
 * @param {string} filePath - Path to the file
 * @returns {Promise<Date>} File creation or modification date
 */
export async function getFileDate(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    return stats.birthtime || stats.mtime;
  } catch {
    return new Date();
  }
}

/** Path key for exclusion checks — Windows paths compare case-insensitively. */
function normalizeDirKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Recursively collect all file paths within a directory.
 * Skips hidden/system directories (dot-prefixed) and any directory listed in
 * options.excludeDirs — in particular the thumbnails folder, which defaults to
 * `<imagesDir>/.thumbnails` and would otherwise be rescanned as photos.
 *
 * @param {string} dir - Directory to scan
 * @param {function} onProgress - Optional callback: (filesFound, dirsScanned) => void
 * @param {object} options - { excludeDirs?: string[] }
 * @param {object} state - Internal state tracker (do not pass manually)
 * @returns {Promise<string[]>} Array of absolute file paths
 */
export async function getAllFilesRecursively(dir, onProgress = null, options = {}, state = null) {
  if (state === null) {
    state = {
      filesFound: 0,
      dirsScanned: 0,
      lastReport: Date.now(),
      excludeDirs: new Set((options.excludeDirs || []).filter(Boolean).map(normalizeDirKey)),
    };
  }

  const allFiles = [];

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err.message);
    return allFiles;
  }
  state.dirsScanned++;

  for (const entry of entries) {
    throwIfCancelled(options.isCancelled);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || state.excludeDirs.has(normalizeDirKey(fullPath))) {
        continue;
      }
      const subFiles = await getAllFilesRecursively(fullPath, onProgress, options, state);
      for (const f of subFiles) {
        allFiles.push(f);
      }
    } else {
      allFiles.push(fullPath);
      state.filesFound++;

      if (onProgress) {
        const now = Date.now();
        if (now - state.lastReport > 300) {
          onProgress(state.filesFound, state.dirsScanned);
          state.lastReport = now;
        }
      }
    }
  }

  return allFiles;
}

/**
 * Build a lookup index for media files: lowercase name -> actual name.
 * Build once per scan and pass to findMediaFile — the previous per-sidecar
 * linear search was O(n²) across the library.
 */
export function buildMediaFileIndex(mediaFiles) {
  const index = new Map();
  for (const file of mediaFiles) {
    const key = file.toLowerCase();
    if (!index.has(key)) {
      index.set(key, file);
    }
  }
  return index;
}

const SUPPLEMENTAL_SUFFIX = '.supplemental-metadata';

/**
 * Find the media file for a sidecar/metadata file
 * Handles XMP (.xmp) and Google Takeout (.json) naming conventions, including
 * Takeout's duplicate naming ("IMG.JPG(1).json" -> "IMG(1).JPG") and its
 * truncation of long names (best-effort unique-prefix match).
 *
 * @param {string} sidecarFilename - Name of the sidecar file (e.g., "IMG_1234.HEIC.xmp")
 * @param {Map<string,string>} mediaIndex - From buildMediaFileIndex()
 * @param {string} extension - Extension to strip (e.g., '.xmp' or '.json')
 * @returns {string|null} Media filename or null if not found
 */
export function findMediaFile(sidecarFilename, mediaIndex, extension = '.xmp') {
  // Remove extension to get the base media filename
  let mediaFilename = sidecarFilename.replace(new RegExp(`${extension}$`, 'i'), '');

  // Strip Google's ".supplemental-metadata" suffix, including truncated
  // variants like ".supplemental-metad" (Takeout caps the name length)
  const suffixMatch = mediaFilename.match(/\.[a-z-]{4,}$/i);
  if (suffixMatch && SUPPLEMENTAL_SUFFIX.startsWith(suffixMatch[0].toLowerCase())) {
    mediaFilename = mediaFilename.slice(0, -suffixMatch[0].length);
  }

  const direct = mediaIndex.get(mediaFilename.toLowerCase());
  if (direct) {
    return direct;
  }

  // Takeout duplicate naming: "IMG_1234.JPG(1)" refers to media "IMG_1234(1).JPG"
  const dupMatch = mediaFilename.match(/^(.*)(\.[A-Za-z0-9]+)(\(\d+\))$/);
  if (dupMatch) {
    const [, base, ext, dup] = dupMatch;
    const relocated = mediaIndex.get(`${base}${dup}${ext}`.toLowerCase());
    if (relocated) {
      return relocated;
    }
  }

  // Takeout truncates long JSON base names; accept a unique prefix match.
  // Only attempted for long names so the linear pass stays rare.
  if (path.basename(mediaFilename).length >= 40) {
    const lowerPrefix = mediaFilename.toLowerCase();
    let match = null;
    for (const [key, actual] of mediaIndex) {
      if (key.startsWith(lowerPrefix)) {
        if (match) {
          return null; // ambiguous
        }
        match = actual;
      }
    }
    return match;
  }

  return null;
}

/**
 * Check if a file is an image based on extension
 * @param {string} filename - Filename to check
 * @returns {boolean}
 */
export function isImage(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a file is a video based on extension
 * @param {string} filename - Filename to check
 * @returns {boolean}
 */
export function isVideo(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Check if a file is a supported media file
 * @param {string} filename - Filename to check
 * @returns {boolean}
 */
export function isMedia(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MEDIA_EXTENSIONS.includes(ext);
}
