/**
 * Shared Adapter Utilities
 * 
 * Common functions and constants used across all metadata adapters.
 */

import fs from 'fs';
import path from 'path';

// Supported media extensions
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'];
export const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v'];
export const MEDIA_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];

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
 * @returns {Date} File creation or modification date
 */
export function getFileDate(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.birthtime || stats.mtime;
  } catch {
    return new Date();
  }
}

/**
 * Recursively collect all file paths within a directory (async version)
 * Uses setImmediate to yield to event loop, allowing SSE updates to flush
 * 
 * @param {string} dir - Directory to scan
 * @param {function} onProgress - Optional callback: (filesFound, dirsScanned) => void
 * @param {object} state - Internal state tracker (do not pass manually)
 * @returns {Promise<string[]>} Array of absolute file paths
 */
export async function getAllFilesRecursively(dir, onProgress = null, state = null) {
  // Initialize state on first call
  if (state === null) {
    state = { filesFound: 0, dirsScanned: 0, lastReport: Date.now() };
  }
  
  let allFiles = [];
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    state.dirsScanned++;
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await getAllFilesRecursively(fullPath, onProgress, state);
        allFiles = allFiles.concat(subFiles);
      } else {
        allFiles.push(fullPath);
        state.filesFound++;
        
        // Report progress every 300ms AND yield to event loop so SSE can flush
        if (onProgress) {
          const now = Date.now();
          if (now - state.lastReport > 300) {
            onProgress(state.filesFound, state.dirsScanned);
            state.lastReport = now;
            // Yield immediately after reporting so SSE buffer flushes
            await new Promise(resolve => setImmediate(resolve));
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err.message);
  }
  
  return allFiles;
}

/**
 * Find the media file for a sidecar/metadata file
 * Handles both XMP (.xmp) and Google Takeout (.json) naming conventions
 * 
 * @param {string} sidecarFilename - Name of the sidecar file (e.g., "IMG_1234.HEIC.xmp")
 * @param {string[]} mediaFiles - List of media files to search
 * @param {string} extension - Extension to strip (e.g., '.xmp' or '.json')
 * @returns {string|null} Media filename or null if not found
 */
export function findMediaFile(sidecarFilename, mediaFiles, extension = '.xmp') {
  // Remove extension to get the base media filename
  let mediaFilename = sidecarFilename.replace(new RegExp(`${extension}$`, 'i'), '');
  
  // Handle Google Photos supplemental metadata naming
  mediaFilename = mediaFilename.replace('.supplemental-metadata', '');

  // Check if the exact file exists
  if (mediaFiles.includes(mediaFilename)) {
    return mediaFilename;
  }

  // Try case-insensitive match
  const lowerMedia = mediaFilename.toLowerCase();
  for (const file of mediaFiles) {
    if (file.toLowerCase() === lowerMedia) {
      return file;
    }
  }

  return null;
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
