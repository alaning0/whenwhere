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

import fs from 'fs';
import path from 'path';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  formatDates,
  getFileDate,
  findMediaFile
} from './utils.js';

/**
 * Scan a directory for XMP sidecar files and extract photo metadata
 * @param {string} imagesDir - Path to the directory containing images and XMP files
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null) {
  console.log('XMP Adapter: Scanning for XMP sidecars...');

  // Phase 1: Collecting files
  if (onProgress) onProgress(0, 0, 'collecting');
  
  const files = fs.readdirSync(imagesDir);
  const xmpFiles = files.filter(f => f.toLowerCase().endsWith('.xmp'));
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });

  const photos = [];
  let idCounter = 1;
  const total = xmpFiles.length;

  // Phase 2: Processing files
  if (onProgress) onProgress(0, total, 'processing');
  
  for (const xmpFile of xmpFiles) {
    if (onProgress && idCounter % 100 === 0) {
      onProgress(idCounter, total, 'processing');
    }
    
    const xmpPath = path.join(imagesDir, xmpFile);
    const mediaFile = findMediaFile(xmpFile, mediaFiles, '.xmp');
    const xmpData = extractXmpData(xmpPath);

    const hasMediaFile = mediaFile !== null;
    const displayFilename = mediaFile || xmpFile.replace(/\.xmp$/i, '');
    const mediaPath = hasMediaFile ? path.join(imagesDir, mediaFile) : null;

    const ext = path.extname(displayFilename).toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.includes(ext);
    const isImage = IMAGE_EXTENSIONS.includes(ext);

    // Use XMP date or file date as fallback
    let photoDate;
    if (xmpData.date) {
      photoDate = new Date(xmpData.date).toISOString();
    } else if (mediaPath) {
      photoDate = getFileDate(mediaPath).toISOString();
    } else {
      photoDate = getFileDate(xmpPath).toISOString();
    }

    const dateObj = new Date(photoDate);
    const formattedDates = formatDates(dateObj);

    const photo = {
      id: idCounter++,
      filename: displayFilename,
      title: displayFilename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
      url: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}` : null,
      thumbnail: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}?thumb=true` : null,
      date: photoDate,
      ...formattedDates,
      lat: xmpData.lat,
      lng: xmpData.lng,
      hasLocation: xmpData.lat !== null && xmpData.lng !== null,
      hasMediaFile,
      isVideo,
      isImage,
      xmpFile,
      size: mediaPath ? fs.statSync(mediaPath).size : 0,
      location: xmpData.lat && xmpData.lng
        ? `${xmpData.lat.toFixed(4)}, ${xmpData.lng.toFixed(4)}`
        : 'Unknown location'
    };

    photos.push(photo);
  }

  // Phase 3: Sorting
  if (onProgress) onProgress(total, total, 'sorting');
  photos.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Phase 4: Complete
  if (onProgress) onProgress(total, total, 'complete');
  
  console.log(`XMP Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS, ${photos.filter(p => p.hasMediaFile).length} with media files)`);

  return photos;
}

/**
 * Extract metadata from XMP sidecar file
 * @param {string} xmpPath - Full path to XMP file
 * @returns {{ lat: number|null, lng: number|null, date: string|null }}
 */
function extractXmpData(xmpPath) {
  try {
    const content = fs.readFileSync(xmpPath, 'utf-8');

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
