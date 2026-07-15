/**
 * EXIF Adapter - Reads GPS and date metadata directly from image EXIF data
 *
 * Expected file structure:
 *   Photos/
 *   ├── IMG_1234.HEIC          # Media file with EXIF data
 *   └── ...
 *
 * Works with:
 *   - Apple iCloud Photos exports
 *   - Any folder containing images with EXIF metadata
 *
 * Files without usable EXIF (screenshots, PNGs, videos) fall back to the
 * file's creation/modification date instead of being dropped.
 */

import fsp from 'fs/promises';
import path from 'path';
import ExifReader from 'exifreader';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  SCAN_CONCURRENCY,
  formatDates,
  getAllFilesRecursively,
  makePhotoId,
  comparePhotosByDate,
  mapWithConcurrency,
  ScanCancelledError,
  maybePublishPartial,
} from './utils.js';

// EXIF lives at the start of the file — reading the whole image is wasted I/O
const EXIF_READ_BYTES = 128 * 1024;

/**
 * Scan a directory for media files and extract EXIF metadata
 * @param {string} imagesDir - Path to the directory containing images
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @param {object} options - { excludeDirs?: string[], isCancelled?: () => boolean, onPartial?: (photos) => void }
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null, options = {}) {
  console.log('EXIF Adapter: Scanning for media files...');
  console.log(`Supported image formats: ${IMAGE_EXTENSIONS.join(', ')}`);

  // Phase 1: Collecting files (with live progress)
  if (onProgress) onProgress(0, 0, 'scanning');

  const files = await getAllFilesRecursively(imagesDir, (filesFound, dirsScanned) => {
    if (onProgress) onProgress(filesFound, dirsScanned, 'scanning');
  }, options);
  if (options.isCancelled?.()) {
    throw new ScanCancelledError();
  }
  console.log(`EXIF Adapter: Found ${files.length} files`);

  // Filter for media files
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });

  const total = mediaFiles.length;
  let completed = 0;
  const gathered = [];

  // Phase 2: Processing files (bounded concurrency)
  if (onProgress) onProgress(0, total, 'processing');

  const results = await mapWithConcurrency(mediaFiles, SCAN_CONCURRENCY, async (mediaFile) => {
    let photo = null;
    try {
      photo = await processMediaFile(mediaFile, serverPort);
    } catch (err) {
      console.error(`[EXIF Adapter] Error processing ${mediaFile}:`, err.message);
    }
    if (photo) gathered.push(photo);
    completed++;
    if (onProgress && (completed % 100 === 0 || completed === total)) {
      onProgress(completed, total, 'processing');
    }
    maybePublishPartial(gathered, completed, total, options.onPartial);
    return photo;
  }, { isCancelled: options.isCancelled });

  const photos = results.filter(Boolean);

  // Phase 3: Sorting
  if (onProgress) onProgress(total, total, 'sorting');
  photos.sort(comparePhotosByDate);

  if (options.onPartial) {
    options.onPartial(photos);
  }

  // Phase 4: Complete
  if (onProgress) onProgress(total, total, 'complete');

  console.log(`EXIF Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS)`);

  return photos;
}

/**
 * Build a photo object for a single media file.
 * EXIF is read for images only; anything without a usable EXIF date
 * (videos, screenshots, PNGs) uses the file date instead.
 */
async function processMediaFile(mediaFile, serverPort) {
  const ext = path.extname(mediaFile).toLowerCase();
  const isVideoFile = VIDEO_EXTENSIONS.includes(ext);
  const isImageFile = IMAGE_EXTENSIONS.includes(ext);

  const stats = await fsp.stat(mediaFile);

  let tags = null;
  if (isImageFile) {
    try {
      const readSize = Math.min(EXIF_READ_BYTES, stats.size);
      const buffer = Buffer.alloc(readSize);
      const fd = await fsp.open(mediaFile, 'r');
      try {
        await fd.read(buffer, 0, readSize, 0);
      } finally {
        await fd.close();
      }
      tags = ExifReader.load(buffer, { expanded: false });
    } catch (err) {
      tags = null; // No parseable EXIF — fall back to file dates below
    }
  }

  const latitude = tags ? parseCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef) : null;
  const longitude = tags ? parseCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef) : null;

  // Parse EXIF date format: "2020:11:08 12:00:17" -> ISO format
  const rawDate = tags ? (tags.DateTimeOriginal?.description || tags.DateTimeOriginal) : null;
  let dateObj = null;
  if (rawDate && typeof rawDate === 'string') {
    const exifMatch = rawDate.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (exifMatch) {
      const [, year, month, day, hour, min, sec] = exifMatch;
      dateObj = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
    } else {
      dateObj = new Date(rawDate);
    }
  }
  if (!dateObj || isNaN(dateObj.getTime())) {
    dateObj = stats.birthtime || stats.mtime;
  }

  const formattedDates = formatDates(dateObj);
  const hasLocation = latitude !== null && longitude !== null;

  return {
    id: makePhotoId(mediaFile),
    filename: mediaFile,
    title: path.basename(mediaFile).replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
    url: `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}`,
    thumbnail: `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}?thumb=true`,
    date: dateObj.toISOString(),
    ...formattedDates,
    lat: latitude,
    lng: longitude,
    hasLocation,
    hasMediaFile: true,
    isVideo: isVideoFile,
    isImage: isImageFile,
    size: stats.size,
    location: hasLocation
      ? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
      : 'Unknown location'
  };
}

/**
 * Parse GPS coordinate from EXIF format to decimal degrees
 * @param {object} coordTag - GPS coordinate tag (GPSLatitude or GPSLongitude)
 * @param {object} refTag - Reference tag (GPSLatitudeRef or GPSLongitudeRef)
 * @returns {number|null} Decimal degrees or null if parsing fails
 */
function parseCoordinate(coordTag, refTag) {
  try {
    if (!coordTag || !refTag) {
      return null;
    }

    let degrees, minutes, seconds;
    let ref;

    // Get reference value (N, S, E, W)
    if (typeof refTag.value === 'string') {
      ref = refTag.value;
    } else if (Array.isArray(refTag.value) && typeof refTag.value[0] === 'string') {
      ref = refTag.value[0];
    } else if (typeof refTag.description === 'string') {
      ref = refTag.description;
    } else {
      return null;
    }

    // Method 1: Direct array of rationals [degrees, minutes, seconds]
    if (Array.isArray(coordTag.value) && coordTag.value.length === 3) {
      function parseRational(val) {
        if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number' && typeof val[1] === 'number' && val[1] !== 0) {
          return val[0] / val[1];
        }
        return typeof val === 'number' ? val : parseFloat(val);
      }
      [degrees, minutes, seconds] = coordTag.value.map(parseRational);
    }
    // Method 2: Already a decimal number
    else if (typeof coordTag.value === 'number') {
      const decimal = coordTag.value;
      return (ref === 'S' || ref === 'W') ? -decimal : decimal;
    }
    // Method 3: Parse from description string like "40° 26' 46.8""
    else if (typeof coordTag.description === 'string') {
      const coord = coordTag.description;
      const parts = coord.match(/(\d+)°\s*(\d+)'\s*([\d.]+)"/);
      if (parts) {
        degrees = parseFloat(parts[1]);
        minutes = parseFloat(parts[2]);
        seconds = parseFloat(parts[3]);
      } else {
        const altParts = coord.match(/(\d+)°\s*(\d+)'\s*([\d.]+)/);
        if (altParts) {
          degrees = parseFloat(altParts[1]);
          minutes = parseFloat(altParts[2]);
          seconds = parseFloat(altParts[3]);
        } else {
          return null;
        }
      }
    } else {
      return null;
    }

    // Convert DMS to decimal degrees
    let decimal = degrees + (minutes / 60) + (seconds / 3600);

    // Apply direction reference
    if (ref === 'S' || ref === 'W') {
      decimal = -decimal;
    }

    return decimal;
  } catch (error) {
    console.error('Error parsing coordinate:', error.message);
    return null;
  }
}

/**
 * Get adapter metadata
 */
export function getAdapterInfo() {
  return {
    name: 'exif',
    displayName: 'EXIF Adapter',
    description: 'Reads GPS and date metadata directly from image EXIF data',
    expectedStructure: 'Directory containing images with embedded EXIF metadata',
    supportedExtensions: MEDIA_EXTENSIONS
  };
}

// Re-export constants for backward compatibility
export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS };
