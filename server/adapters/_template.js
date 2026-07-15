/**
 * Template Adapter - Use this as a starting point for new adapters
 * 
 * Each adapter must export:
 *   - scanPhotos(imagesDir, serverPort, onProgress, options) - Scans directory and returns photo array
 *     options: { excludeDirs?: string[], isCancelled?: () => boolean, onPartial?: (photos) => void }
 *     — excludeDirs: directories the walker must skip (forward to getAllFilesRecursively)
 *     — isCancelled: return true to abort the scan cooperatively (throw ScanCancelledError)
 *     — onPartial: publish photos gathered so far (~every 250 files) for background UI updates
 *   - getAdapterInfo() - Returns metadata about the adapter
 *
 * Optionally re-export these constants for backward compatibility:
 *   - IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS
 *
 * Photo object structure (returned by scanPhotos):
 *   {
 *     id: string,              // Stable unique id — use makePhotoId(<unique file path>)
 *                              // so ids survive rescans; hash the per-record
 *                              // unique path (sidecar path if you scan sidecars)
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

import fsp from 'fs/promises';
import path from 'path';
import {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  SCAN_CONCURRENCY,
  formatDates,
  getFileDate,
  makePhotoId,
  comparePhotosByDate,
  mapWithConcurrency,
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
 * @param {object} options - { excludeDirs?: string[], isCancelled?: () => boolean }
 * @returns {Promise<Array>} - Array of photo metadata objects
 */
export async function scanPhotos(imagesDir, serverPort, onProgress = null, options = {}) {
  console.log('Template Adapter: Scanning directory...');

  // Phase 1: Collecting files
  if (onProgress) onProgress(0, 0, 'scanning');

  const photos = [];

  // TODO: Implement your scanning logic here
  //
  // Example structure:
  // 1. Read files from imagesDir (use getAllFilesRecursively(imagesDir, cb, options)
  //    for subdirectories — it skips hidden folders and options.excludeDirs)
  // 2. Process files with mapWithConcurrency(files, SCAN_CONCURRENCY, fn, { isCancelled: options.isCancelled }) —
  //    use fs/promises, never the *Sync variants (they block the event loop)
  // 3. Build photo objects with all required fields; return null to skip a file
  // 4. Filter out nulls, sort, return

  // Example pseudo-code:
  // const files = await fsp.readdir(imagesDir);
  // const mediaFiles = files.filter(f => isImage(f) || isVideo(f));
  // const total = mediaFiles.length;
  // let completed = 0;
  //
  // if (onProgress) onProgress(0, total, 'processing');
  //
  // const results = await mapWithConcurrency(mediaFiles, SCAN_CONCURRENCY, async (file) => {
  //   const filePath = path.join(imagesDir, file);
  //   const metadata = await extractMetadata(filePath);  // Your implementation
  //   const dateObj = new Date(metadata.date);
  //   completed++;
  //   if (onProgress && (completed % 100 === 0 || completed === total)) {
  //     onProgress(completed, total, 'processing');
  //   }
  //
  //   return {
  //     id: makePhotoId(filePath),
  //     filename: file,
  //     title: file.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
  //     url: `http://localhost:${serverPort}/images/${encodeURIComponent(file)}`,
  //     thumbnail: `http://localhost:${serverPort}/images/${encodeURIComponent(file)}?thumb=true`,
  //     date: dateObj.toISOString(),
  //     ...formatDates(dateObj),
  //     lat: metadata.lat,
  //     lng: metadata.lng,
  //     hasLocation: metadata.lat !== null && metadata.lng !== null,
  //     hasMediaFile: true,
  //     isVideo: isVideo(file),
  //     isImage: isImage(file),
  //     size: (await fsp.stat(filePath)).size,
  //     location: metadata.lat !== null && metadata.lng !== null
  //       ? `${metadata.lat.toFixed(4)}, ${metadata.lng.toFixed(4)}`
  //       : 'Unknown location'
  //   };
  // });
  // photos.push(...results.filter(Boolean));

  // Phase 3: Sorting (ISO date strings with id tiebreak — stable across rescans)
  if (onProgress) onProgress(photos.length, photos.length, 'sorting');
  photos.sort(comparePhotosByDate);

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
