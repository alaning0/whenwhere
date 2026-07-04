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
 * @returns {Promise<Array>} results in item order
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
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

/**
 * Find the media file for a sidecar/metadata file
 * Handles both XMP (.xmp) and Google Takeout (.json) naming conventions
 *
 * @param {string} sidecarFilename - Name of the sidecar file (e.g., "IMG_1234.HEIC.xmp")
 * @param {Map<string,string>} mediaIndex - From buildMediaFileIndex()
 * @param {string} extension - Extension to strip (e.g., '.xmp' or '.json')
 * @returns {string|null} Media filename or null if not found
 */
export function findMediaFile(sidecarFilename, mediaIndex, extension = '.xmp') {
  // Remove extension to get the base media filename
  let mediaFilename = sidecarFilename.replace(new RegExp(`${extension}$`, 'i'), '');

  // Handle Google Photos supplemental metadata naming
  mediaFilename = mediaFilename.replace('.supplemental-metadata', '');

  return mediaIndex.get(mediaFilename.toLowerCase()) || null;
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
