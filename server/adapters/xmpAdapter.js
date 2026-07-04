/**
 * XMP Adapter - Reads metadata from XMP sidecar files (osxphotos export)
 *
 * Expected file structure:
 *   Content/
 *   ├── IMG_1234.HEIC          # Media file
 *   ├── IMG_1234.HEIC.xmp      # XMP sidecar with GPS/date metadata
 *   └── ...
 *
 * XMP files are named: {mediafile}.xmp (e.g., IMG_1234.HEIC.xmp)
 *
 * Works with:
 *   - osxphotos exports with --sidecar xmp flag
 *   - Any XMP sidecar files following this naming convention
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
  makePhotoId,
  comparePhotosByDate,
  mapWithConcurrency
} from './utils.js';

/**
 * Scan a directory for XMP sidecar files and extract photo metadata
 * @param {string} imagesDir - Path to the directory containing images and XMP files
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @param {object} options - Reserved for walker options (unused: this adapter scans a flat directory)
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null, options = {}) {
  console.log('XMP Adapter: Scanning for XMP sidecars...');

  // Phase 1: Collecting files
  if (onProgress) onProgress(0, 0, 'collecting');

  const files = await fsp.readdir(imagesDir);
  const xmpFiles = files.filter(f => f.toLowerCase().endsWith('.xmp'));
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });
  const mediaIndex = buildMediaFileIndex(mediaFiles);

  const total = xmpFiles.length;
  let completed = 0;

  // Phase 2: Processing files (bounded concurrency)
  if (onProgress) onProgress(0, total, 'processing');

  const results = await mapWithConcurrency(xmpFiles, SCAN_CONCURRENCY, async (xmpFile) => {
    let photo = null;
    try {
      photo = await processXmpFile(imagesDir, xmpFile, mediaIndex, serverPort);
    } catch (err) {
      console.error(`[XMP Adapter] Error processing ${xmpFile}:`, err.message);
    }
    completed++;
    if (onProgress && (completed % 100 === 0 || completed === total)) {
      onProgress(completed, total, 'processing');
    }
    return photo;
  });

  const photos = results.filter(Boolean);

  // Phase 3: Sorting
  if (onProgress) onProgress(total, total, 'sorting');
  photos.sort(comparePhotosByDate);

  // Phase 4: Complete
  if (onProgress) onProgress(total, total, 'complete');

  console.log(`XMP Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS, ${photos.filter(p => p.hasMediaFile).length} with media files)`);

  return photos;
}

/**
 * Build a photo object for a single XMP sidecar.
 */
async function processXmpFile(imagesDir, xmpFile, mediaIndex, serverPort) {
  const xmpPath = path.join(imagesDir, xmpFile);
  const mediaFile = findMediaFile(xmpFile, mediaIndex, '.xmp');
  const xmpData = await extractXmpData(xmpPath);

  const hasMediaFile = mediaFile !== null;
  const displayFilename = mediaFile || xmpFile.replace(/\.xmp$/i, '');
  const mediaPath = hasMediaFile ? path.join(imagesDir, mediaFile) : null;

  const ext = path.extname(displayFilename).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.includes(ext);
  const isImage = IMAGE_EXTENSIONS.includes(ext);

  // Use XMP date when valid; fall back to the file date. An unparseable XMP
  // date must not throw — one bad sidecar used to kill the whole scan.
  let dateObj = null;
  if (xmpData.date) {
    const parsed = new Date(xmpData.date);
    if (!isNaN(parsed.getTime())) {
      dateObj = parsed;
    }
  }
  if (!dateObj) {
    dateObj = await getFileDate(mediaPath || xmpPath);
  }

  const formattedDates = formatDates(dateObj);
  const hasLocation = xmpData.lat !== null && xmpData.lng !== null;

  let size = 0;
  if (mediaPath) {
    size = await fsp.stat(mediaPath).then(s => s.size).catch(() => 0);
  }

  return {
    id: makePhotoId(xmpPath),
    filename: displayFilename,
    title: displayFilename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
    url: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}` : null,
    thumbnail: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}?thumb=true` : null,
    date: dateObj.toISOString(),
    ...formattedDates,
    lat: xmpData.lat,
    lng: xmpData.lng,
    hasLocation,
    hasMediaFile,
    isVideo,
    isImage,
    xmpFile,
    size,
    location: hasLocation
      ? `${xmpData.lat.toFixed(4)}, ${xmpData.lng.toFixed(4)}`
      : 'Unknown location'
  };
}

/**
 * Extract metadata from XMP sidecar file
 * @param {string} xmpPath - Full path to XMP file
 * @returns {Promise<{ lat: number|null, lng: number|null, date: string|null }>}
 */
async function extractXmpData(xmpPath) {
  try {
    const content = await fsp.readFile(xmpPath, 'utf-8');

    let lat = null;
    let lng = null;
    let date = null;

    // Extract GPS coordinates
    const latMatch = content.match(/<exif:GPSLatitude>([^<]+)<\/exif:GPSLatitude>/);
    const lngMatch = content.match(/<exif:GPSLongitude>([^<]+)<\/exif:GPSLongitude>/);

    if (latMatch) {
      lat = parseXmpGpsCoordinate(latMatch[1]);
    }
    if (lngMatch) {
      lng = parseXmpGpsCoordinate(lngMatch[1]);
    }

    // Extract date - try multiple formats
    const dateCreatedMatch = content.match(/<photoshop:DateCreated>([^<]+)<\/photoshop:DateCreated>/);
    const xmpCreateMatch = content.match(/<xmp:CreateDate>([^<]+)<\/xmp:CreateDate>/);

    if (dateCreatedMatch) {
      date = dateCreatedMatch[1];
    } else if (xmpCreateMatch) {
      date = xmpCreateMatch[1];
    }

    return { lat, lng, date };
  } catch (error) {
    console.error(`Error reading XMP ${xmpPath}:`, error.message);
    return { lat: null, lng: null, date: null };
  }
}

/**
 * Parse GPS coordinate from XMP format
 * Format: "175,5.375999999999408E" or "37,4.006830000000008S"
 * This is: degrees,decimal_minutes + direction
 */
function parseXmpGpsCoordinate(coordStr) {
  if (!coordStr) return null;

  const match = coordStr.match(/^(\d+),(\d+\.?\d*)([NSEW])$/i);
  if (!match) return null;

  const degrees = parseFloat(match[1]);
  const minutes = parseFloat(match[2]);
  const direction = match[3].toUpperCase();

  let dd = degrees + (minutes / 60);

  if (direction === 'S' || direction === 'W') {
    dd = -dd;
  }

  return dd;
}

/**
 * Get adapter metadata
 */
export function getAdapterInfo() {
  return {
    name: 'xmp',
    displayName: 'OSXPhotos XMP Export',
    description: 'Reads GPS and date metadata from XMP sidecar files exported by osxphotos',
    expectedStructure: 'Flat directory with .xmp files alongside media files',
    supportedExtensions: MEDIA_EXTENSIONS
  };
}

// Re-export constants for backward compatibility
export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS };
