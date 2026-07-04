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
  comparePhotosByDate,
  mapWithConcurrency
} from './utils.js';

// EXIF lives at the start of the file — reading the whole image is wasted I/O
const EXIF_READ_BYTES = 128 * 1024;

/**
 * Scan a directory for media files and extract EXIF metadata
 * @param {string} imagesDir - Path to the directory containing images
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @param {object} options - { excludeDirs?: string[] } directories to skip (e.g. the thumbnails folder)
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
  console.log(`EXIF Adapter: Found ${files.length} files`);

  // Filter for media files
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });

  const total = mediaFiles.length;
  let completed = 0;

  // Phase 2: Processing files (bounded concurrency)
  if (onProgress) onProgress(0, total, 'processing');

  const results = await mapWithConcurrency(mediaFiles, SCAN_CONCURRENCY, async (mediaFile, index) => {
    let photo = null;
    try {
      photo = await processMediaFile(mediaFile, index, serverPort);
    } catch (err) {
      console.error(`[EXIF Adapter] Error processing ${mediaFile}:`, err.message);
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

  console.log(`EXIF Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS)`);

  return photos;
}

/**
 * Build a photo object for a single media file.
 */
async function processMediaFile(mediaFile, index, serverPort) {
  const ext = path.extname(mediaFile).toLowerCase();
  const isVideoFile = VIDEO_EXTENSIONS.includes(ext);
  const isImageFile = IMAGE_EXTENSIONS.includes(ext);

  if (isVideoFile) {
    // Can't handle video EXIF yet
    return null;
  }

  const stats = await fsp.stat(mediaFile);

  let tags;
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
    console.error(`[EXIF Adapter] Error reading EXIF for: ${mediaFile}`, err.message);
    return null;
  }

  const latitude = parseCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef);
  const longitude = parseCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef);
  const rawDate = tags.DateTimeOriginal?.description || tags.DateTimeOriginal;

  // Parse EXIF date format: "2020:11:08 12:00:17" -> ISO format
  let dateObj;
  if (rawDate && typeof rawDate === 'string') {
    const exifMatch = rawDate.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (exifMatch) {
      const [, year, month, day, hour, min, sec] = exifMatch;
      dateObj = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
    } else {
      dateObj = new Date(rawDate);
    }
  } else {
    dateObj = new Date(rawDate);
  }

  // Skip if date is invalid
  if (isNaN(dateObj.getTime())) {
    console.warn(`[EXIF Adapter] Invalid date for ${mediaFile}: ${rawDate}`);
    return null;
  }

  const formattedDates = formatDates(dateObj);
  const hasLocation = latitude !== null && longitude !== null;

  return {
    id: index + 1,
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
