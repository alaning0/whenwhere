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

import fs from 'fs';
import path from 'path';
import ExifReader from 'exifreader';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  formatDates,
  getAllFilesRecursively
} from './utils.js';

/**
 * Scan a directory for media files and extract EXIF metadata
 * @param {string} imagesDir - Path to the directory containing images
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null) {
  console.log('EXIF Adapter: Scanning for media files...');
  console.log(`Supported image formats: ${IMAGE_EXTENSIONS.join(', ')}`);

  // Phase 1: Collecting files (with live progress)
  if (onProgress) onProgress(0, 0, 'scanning');
  
  const files = await getAllFilesRecursively(imagesDir, (filesFound, dirsScanned) => {
    if (onProgress) onProgress(filesFound, dirsScanned, 'scanning');
  });
  console.log(`EXIF Adapter: Found ${files.length} files`);
  
  // Filter for media files
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });

  const photos = [];
  let idCounter = 1;
  const total = mediaFiles.length;

  // Phase 2: Processing files
  if (onProgress) onProgress(0, total, 'processing');
  
  for (const mediaFile of mediaFiles) {
    // Report progress every 100 files and yield every 500 to flush SSE
    if (onProgress && idCounter % 100 === 0) {
      onProgress(idCounter, total, 'processing');
      if (idCounter % 500 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    
    const ext = path.extname(mediaFile).toLowerCase();
    const isVideoFile = VIDEO_EXTENSIONS.includes(ext);
    const isImageFile = IMAGE_EXTENSIONS.includes(ext);

    // Extract EXIF metadata (only for images)
    let tags;
    try {
      if (isImageFile) {
        // Only read first 128KB - EXIF is always at start of file
        const fd = fs.openSync(mediaFile, 'r');
        const stats = fs.fstatSync(fd);
        const readSize = Math.min(128 * 1024, stats.size);
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, 0);
        fs.closeSync(fd);
        
        tags = ExifReader.load(buffer, { expanded: false });
      } else if (isVideoFile) {
        // Can't handle video EXIF yet
        continue;
      }
    } catch (err) {
      console.error(`[EXIF Adapter] Error reading EXIF for: ${mediaFile}`, err.message);
      continue;
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
      continue;
    }
    
    const formattedDates = formatDates(dateObj);

    const photo = {
      id: idCounter++,
      filename: mediaFile,
      title: path.basename(mediaFile).replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
      url: `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}`,
      thumbnail: `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}?thumb=true`,
      date: dateObj.toISOString(),
      ...formattedDates,
      lat: latitude,
      lng: longitude,
      hasLocation: latitude !== null && longitude !== null,
      hasMediaFile: true,
      isVideo: isVideoFile,
      isImage: isImageFile,
      size: fs.statSync(mediaFile).size,
      location: latitude && longitude
        ? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
        : 'Unknown location'
    };

    photos.push(photo);
  }

  // Phase 3: Sorting
  if (onProgress) onProgress(total, total, 'sorting');
  photos.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Phase 4: Complete
  if (onProgress) onProgress(total, total, 'complete');
  
  console.log(`EXIF Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS)`);

  return photos;
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
