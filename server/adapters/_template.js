/**
 * Template Adapter - Use this as a starting point for new adapters
 * 
 * Each adapter must export:
 *   - scanPhotos(imagesDir, serverPort, onProgress) - Scans directory and returns photo array
 *   - getAdapterInfo() - Returns metadata about the adapter
 * 
 * Optionally re-export these constants for backward compatibility:
 *   - IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS
 * 
 * Photo object structure (returned by scanPhotos):
 *   {
 *     id: number,              // Unique identifier
 *     filename: string,        // Media filename (e.g., "IMG_1234.HEIC")
 *     title: string,           // Display title
 *     url: string|null,        // Full URL to serve original media
 *     thumbnail: string|null,  // URL for thumbnail (with ?thumb=true)
 *     date: string,            // ISO date string
 *     dateFormatted: string,   // "January 1, 2024"
 *     dateShort: string,       // "Jan 1, '24"
 *     timeFormatted: string,   // "3:45 PM"
 *     timeShort: string,       // "15:45"
 *     lat: number|null,        // Latitude (decimal degrees)
 *     lng: number|null,        // Longitude (decimal degrees)
 *     hasLocation: boolean,    // Whether GPS data exists
 *     hasMediaFile: boolean,   // Whether media file exists on disk
 *     isVideo: boolean,        // Whether this is a video
 *     isImage: boolean,        // Whether this is an image
 *     size: number,            // File size in bytes
 *     location: string,        // Formatted lat/lng or "Unknown location"
 *     
 *     // Adapter-specific fields (optional):
 *     xmpFile: string,         // For XMP adapter: name of XMP sidecar
 *     jsonFile: string,        // For Google adapter: name of JSON metadata file
 *   }
 */

import fs from 'fs';
import path from 'path';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  formatDates,
  getFileDate,
  isImage,
  isVideo
} from './utils.js';

/**
 * Scan a directory and extract photo metadata
 * 
 * @param {string} imagesDir - Path to the directory containing images
 * @param {number} serverPort - Port number for constructing URLs
 * @param {function} onProgress - Optional callback: (current, total, phase) => void
 *                                Phases: 'scanning', 'processing', 'sorting', 'complete'
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null) {
  console.log('Template Adapter: Scanning directory...');

  // Phase 1: Collecting files
  if (onProgress) onProgress(0, 0, 'scanning');

  const photos = [];
  let idCounter = 1;

  // TODO: Implement your scanning logic here
  // 
  // Example structure:
  // 1. Read files from imagesDir (use getAllFilesRecursively for subdirectories)
  // 2. For each media file, extract metadata (from EXIF, JSON, database, etc.)
  // 3. Build photo object with all required fields
  // 4. Push to photos array

  // Example pseudo-code:
  // const files = fs.readdirSync(imagesDir);
  // const total = files.length;
  // 
  // if (onProgress) onProgress(0, total, 'processing');
  // 
  // for (const file of files) {
  //   if (isImage(file) || isVideo(file)) {
  //     const filePath = path.join(imagesDir, file);
  //     const metadata = extractMetadata(filePath);  // Your implementation
  //     const dateObj = new Date(metadata.date);
  //     
  //     photos.push({
  //       id: idCounter++,
  //       filename: file,
  //       title: file.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
  //       url: `http://localhost:${serverPort}/images/${encodeURIComponent(file)}`,
  //       thumbnail: `http://localhost:${serverPort}/images/${encodeURIComponent(file)}?thumb=true`,
  //       date: dateObj.toISOString(),
  //       ...formatDates(dateObj),
  //       lat: metadata.lat,
  //       lng: metadata.lng,
  //       hasLocation: metadata.lat !== null && metadata.lng !== null,
  //       hasMediaFile: true,
  //       isVideo: isVideo(file),
  //       isImage: isImage(file),
  //       size: fs.statSync(filePath).size,
  //       location: metadata.lat 
  //         ? `${metadata.lat.toFixed(4)}, ${metadata.lng.toFixed(4)}` 
  //         : 'Unknown location'
  //     });
  //     
  //     if (onProgress && idCounter % 100 === 0) {
  //       onProgress(idCounter, total, 'processing');
  //     }
  //   }
  // }

  // Phase 3: Sorting
  if (onProgress) onProgress(photos.length, photos.length, 'sorting');
  photos.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Phase 4: Complete
  if (onProgress) onProgress(photos.length, photos.length, 'complete');

  console.log(`Template Adapter: Found ${photos.length} photos`);
  return photos;
}

/**
 * Get adapter metadata
 * This helps identify which adapter is in use and what it expects
 */
export function getAdapterInfo() {
  return {
    name: 'template',
    displayName: 'Template Adapter',
    description: 'Template for creating new adapters - customize for your needs',
    expectedStructure: 'Describe your expected file/folder structure here',
    supportedExtensions: MEDIA_EXTENSIONS
  };
}

// Re-export constants for use by server
export { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS };
