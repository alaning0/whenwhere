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
 */

import fs from 'fs';
import path from 'path';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  formatDates,
  getFileDate,
  findMediaFile,
  getAllFilesRecursively
} from './utils.js';

/**
 * Scan a directory for JSON metadata files and extract photo metadata
 * @param {string} imagesDir - Path to the directory containing images and JSON files
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback for progress updates: (current, total, phase) => void
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null) {
  console.log('Google Photos Takeout Adapter: Scanning for JSON metadata...');

  // Phase 1: Collecting files (with live progress)
  if (onProgress) onProgress(0, 0, 'scanning');
  
  const files = await getAllFilesRecursively(imagesDir, (filesFound, dirsScanned) => {
    if (onProgress) onProgress(filesFound, dirsScanned, 'scanning');
  });
  console.log(`Google Photos Takeout Adapter: Found ${files.length} files`);
  
  const jsonFiles = files.filter(f => f.toLowerCase().endsWith('.json'));
  const mediaFiles = files.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MEDIA_EXTENSIONS.includes(ext);
  });

  const photos = [];
  let idCounter = 1;
  const total = jsonFiles.length;

  // Phase 2: Processing files
  if (onProgress) onProgress(0, total, 'processing');
  
  for (const jsonFile of jsonFiles) {
    // Report progress every 100 files and yield every 500 to flush SSE
    if (onProgress && idCounter % 100 === 0) {
      onProgress(idCounter, total, 'processing');
      if (idCounter % 500 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    const mediaFile = findMediaFile(jsonFile, mediaFiles, '.json');
    const jsonData = extractJsonData(jsonFile);

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
      photoDate = getFileDate(mediaFile).toISOString();
    } else {
      photoDate = getFileDate(jsonFile).toISOString();
    }

    const dateObj = new Date(photoDate);
    const formattedDates = formatDates(dateObj);

    const photo = {
      id: idCounter++,
      filename: displayFilename,
      title: path.basename(displayFilename).replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
      url: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}` : null,
      thumbnail: hasMediaFile ? `http://localhost:${serverPort}/images/${encodeURIComponent(mediaFile)}?thumb=true` : null,
      date: photoDate,
      ...formattedDates,
      lat: jsonData.lat,
      lng: jsonData.lng,
      hasLocation: jsonData.lat !== null && jsonData.lng !== null,
      hasMediaFile,
      isVideo,
      isImage,
      jsonFile,
      size: hasMediaFile ? fs.statSync(mediaFile).size : 0,
      location: jsonData.lat && jsonData.lng
        ? `${jsonData.lat.toFixed(4)}, ${jsonData.lng.toFixed(4)}`
        : 'Unknown location'
    };

    photos.push(photo);
  }

  // Phase 3: Sorting
  if (onProgress) onProgress(total, total, 'sorting');
  photos.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Phase 4: Complete
  if (onProgress) onProgress(total, total, 'complete');
  
  console.log(`Google Photos Takeout Adapter: Found ${photos.length} photos (${photos.filter(p => p.hasLocation).length} with GPS, ${photos.filter(p => p.hasMediaFile).length} with media files)`);

  return photos;
}

/**
 * Extract metadata from Google Photos Takeout JSON file
 * @param {string} jsonPath - Full path to JSON file
 * @returns {{ lat: number|null, lng: number|null, date: string|null }}
 */
function extractJsonData(jsonPath) {
  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const jsonData = JSON.parse(content);

    const lat = jsonData.geoData?.latitude || null;
    const lng = jsonData.geoData?.longitude || null;
    const date = jsonData.photoTakenTime?.timestamp 
      ? new Date(Number(jsonData.photoTakenTime.timestamp) * 1000).toISOString() 
      : null;

    return { lat, lng, date };
  } catch (error) {
    console.error(`Error reading JSON ${jsonPath}:`, error.message);
    return { lat: null, lng: null, date: null };
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
