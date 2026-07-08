/**
 * Google Photos Takeout Adapter - Reads metadata from Google Takeout JSON files
 *
 * Expected file structure:
 *   Google Photos/
 *   ├── Photos from 2023/
 *   │   ├── IMG_1234.HEIC          # Media file
 *   │   ├── IMG_1234.HEIC.json     # JSON metadata with GPS/date
 *   │   └── ...
 *   └── ...
 *
 * JSON files are named: {mediafile}.json (e.g., IMG_1234.HEIC.json)
 *
 * Works with:
 *   - Google Photos Takeout exports
 *   - Supports recursive subdirectory scanning
 *
 * Album/system metadata JSONs (metadata.json, shared album comments, etc.)
 * are skipped — only JSONs with a photoTakenTime are treated as photos.
 */

import fsp from 'fs/promises';
import path from 'path';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  SCAN_CONCURRENCY,
  formatDates,
  getFileDate,
  buildMediaFileIndex,
  findMediaFile,
  getAllFilesRecursively,
  makePhotoId,
  comparePhotosByDate,
  mapWithConcurrency,
  ScanCancelledError,
} from './utils.js';

// Takeout files that are never photo sidecars, by exact basename
const NON_PHOTO_JSON = new Set([
  'print-subscriptions.json',
  'shared_album_comments.json',
  'user-generated-memory-titles.json',
]);

function isNonPhotoJson(jsonPath) {
  const base = path.basename(jsonPath).toLowerCase();
  // Album-level metadata: "metadata.json", "metadata(1).json", ...
  if (/^metadata(\(\d+\))?\.json$/.test(base)) {
    return true;
  }
  return NON_PHOTO_JSON.has(base);
}

/**
 * Scan a directory for JSON metadata files and extract photo metadata
 * @param {string} imagesDir - Path to the directory containing images and JSON files
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @param {object} options - { excludeDirs?: string[], isCancelled?: () => boolean }
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null, options = {}) {
  console.log('Google Photos Takeout Adapter: Scanning for JSON metadata...');

  // Phase 1: Collecting files (with live progress)
  if (onProgress) onProgress(0, 0, 'scanning');

  const files = await getAllFilesRecursively(imagesDir, (filesFound, dirsScanned) => {
    if (onProgress) onProgress(filesFound, dirsScanned, 'scanning');
  }, options);
  if (options.isCancelled?.()) {
    throw new ScanCancelledError();
  }
  console.log(`Google Photos Takeout Adapter: Found ${files.length} files`);

  const jsonFiles = files.filter(f => f.toLowerCase().endsWith('.json') && !isNonPhotoJson(f));
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });
  const mediaIndex = buildMediaFileIndex(mediaFiles);

  const total = jsonFiles.length;
  let completed = 0;

  // Phase 2: Processing files (bounded concurrency)
  if (onProgress) onProgress(0, total, 'processing');

  const results = await mapWithConcurrency(jsonFiles, SCAN_CONCURRENCY, async (jsonFile) => {
    let photo = null;
    try {
      photo = await processJsonFile(jsonFile, mediaIndex, serverPort);
    } catch (err) {
      console.error(`[Takeout Adapter] Error processing ${jsonFile}:`, err.message);
    }
    completed++;
    if (onProgress && (completed % 100 === 0 || completed === total)) {
      onProgress(completed, total, 'processing');
    }
    return photo;
  }, { isCancelled: options.isCancelled });

  const photos = results.filter(Boolean);

  // Phase 3: Sorting
  if (onProgress) onProgress(total, total, 'sorting');
  photos.sort(comparePhotosByDate);

  // Phase 4: Complete
  if (onProgress) onProgress(total, total, 'complete');

  console.log(`Google Photos Takeout Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS, ${photos.filter(p => p.hasMediaFile).length} with media files)`);

  return photos;
}

/**
 * Build a photo object for a single Takeout JSON sidecar.
 * Returns null for album/system metadata (no photoTakenTime).
 */
async function processJsonFile(jsonFile, mediaIndex, serverPort) {
  const jsonData = await extractJsonData(jsonFile);
  if (!jsonData.isPhoto) {
    return null;
  }

  const mediaFile = findMediaFile(jsonFile, mediaIndex, '.json');
  const hasMediaFile = mediaFile !== null;
  const displayFilename = mediaFile || jsonFile.replace(/\.json$/i, '');

  const ext = path.extname(displayFilename).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  const isImage = IMAGE_EXTENSIONS.includes(ext);

  // Use JSON date or file date as fallback
  let photoDate;
  if (jsonData.date) {
    photoDate = jsonData.date;
  } else if (mediaFile) {
    photoDate = (await getFileDate(mediaFile)).toISOString();
  } else {
    photoDate = (await getFileDate(jsonFile)).toISOString();
  }

  const dateObj = new Date(photoDate);
  const formattedDates = formatDates(dateObj);
  const hasLocation = jsonData.lat !== null && jsonData.lng !== null;

  let size = 0;
  if (hasMediaFile) {
    size = await fsp.stat(mediaFile).then(s => s.size).catch(() => 0);
  }

  return {
    id: makePhotoId(jsonFile),
    filename: displayFilename,
    title: path.basename(displayFilename).replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
    url: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}` : null,
    thumbnail: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}?thumb=true` : null,
    date: photoDate,
    ...formattedDates,
    lat: jsonData.lat,
    lng: jsonData.lng,
    hasLocation,
    hasMediaFile,
    isVideo,
    isImage,
    jsonFile,
    size,
    location: hasLocation
      ? `${jsonData.lat.toFixed(4)}, ${jsonData.lng.toFixed(4)}`
      : 'Unknown location'
  };
}

/**
 * Extract metadata from Google Photos Takeout JSON file.
 * isPhoto distinguishes real photo sidecars (which always carry
 * photoTakenTime) from album/system metadata files.
 *
 * @param {string} jsonPath - Full path to JSON file
 * @returns {Promise<{ lat: number|null, lng: number|null, date: string|null, isPhoto: boolean }>}
 */
async function extractJsonData(jsonPath) {
  try {
    const content = await fsp.readFile(jsonPath, 'utf-8');
    const jsonData = JSON.parse(content);

    // Takeout writes 0,0 for photos without location data
    const lat = jsonData.geoData?.latitude || null;
    const lng = jsonData.geoData?.longitude || null;

    let date = null;
    const timestamp = jsonData.photoTakenTime?.timestamp;
    if (timestamp) {
      const parsed = new Date(Number(timestamp) * 1000);
      if (!isNaN(parsed.getTime())) {
        date = parsed.toISOString();
      }
    }

    return { lat, lng, date, isPhoto: Boolean(timestamp) };
  } catch (error) {
    console.error(`Error reading JSON ${jsonPath}:`, error.message);
    return { lat: null, lng: null, date: null, isPhoto: false };
  }
}

/**
 * Get adapter metadata
 */
export function getAdapterInfo() {
  return {
    name: 'google-takeout',
    displayName: 'Google Photos Takeout',
    description: 'Reads GPS and date metadata from JSON files exported by Google Photos Takeout',
    expectedStructure: 'Directory tree with .json files alongside media files',
    supportedExtensions: MEDIA_EXTENSIONS
  };
}

// Re-export constants for backward compatibility
export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS };
