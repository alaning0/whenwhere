import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import config from './config.js';

/// Load adapter based on configuration

// Dynamically import the configured adapter
const adapterMap = {
  'exif': './adapters/exifAdapter.js',
  'xmp': './adapters/xmpAdapter.js',
  'google-takeout': './adapters/GooglePhotosTakeoutAdapter.js',
};

const adapterPath = adapterMap[config.adapter];
if (!adapterPath) {
  console.error(`Unknown adapter: ${config.adapter}`);
  process.exit(1);
}

const metadataAdapter = await import(adapterPath);

// Use paths from centralized config
const IMAGES_DIR = config.imagesDir;
const THUMBNAILS_DIR = config.thumbnailsDir;

// Ensure thumbnails directory exists
if (!fs.existsSync(THUMBNAILS_DIR)) {
  fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

/**
 * True when filePath resolves to a path inside rootDir (handles ".." and Windows vs POSIX).
 */
function isResolvedPathInsideDir(filePath, rootDir) {
  const resolvedFile = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootDir);
  const relative = path.relative(resolvedRoot, resolvedFile);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

///

const execAsync = promisify(exec);

const app = express();
const PORT = config.port;

// Enable CORS for React frontend
app.use(cors());

// Thumbnail settings
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_QUALITY = 80;

// Get supported extensions from adapter
const { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS } = metadataAdapter;

/**
 * Detect actual image format by reading magic bytes
 * Returns: 'jpeg', 'png', 'gif', 'webp', 'heic', 'tiff', 'bmp', or null if unknown
 */
function detectImageFormat(buffer) {
  if (buffer.length < 12) return null;
  
  // JPEG: starts with FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpeg';
  }
  
  // PNG: starts with 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png';
  }
  
  // GIF: starts with GIF87a or GIF89a
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'gif';
  }
  
  // WebP: starts with RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }
  
  // TIFF: starts with II (little-endian) or MM (big-endian) followed by 42
  if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
      (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)) {
    return 'tiff';
  }
  
  // BMP: starts with BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return 'bmp';
  }
  
  // HEIC/HEIF: has "ftyp" at offset 4-7 with heic, heix, hevc, mif1, etc.
  if (buffer.length >= 12) {
    const ftyp = buffer.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') {
      const brand = buffer.slice(8, 12).toString('ascii');
      if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
        return 'heic';
      }
      // Could also be MOV/MP4 video
      if (['qt  ', 'isom', 'mp41', 'mp42', 'M4V ', 'avc1'].includes(brand)) {
        return 'video';
      }
    }
  }
  
  return null;
}

// Cache for photo metadata
let photoCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60000; // 1 minute

// Track background thumbnail generation
let backgroundGenerationInProgress = false;

// Cache for thumbnail status (avoid counting 4000+ files on every request)
let thumbnailStatusCache = null;
let thumbnailStatusCacheTime = null;
const THUMBNAIL_STATUS_CACHE_DURATION = 5000; // 5 seconds

// Priority queue for viewport-first thumbnail generation
let priorityQueue = [];
let processingPriority = false;

/**
 * Get the thumbnail path for a given filename
 */
function getThumbnailPath(filename) {
  // Handle full paths - extract just the filename for thumbnail storage
  // Use a hash of the full path to avoid collisions from same-named files in different folders
  const basename = path.basename(filename);
  
  // If it's a full path, include a hash to distinguish files with same name in different folders
  if (filename.includes('/') || filename.includes('\\')) {
    const hash = crypto.createHash('md5').update(filename).digest('hex').substring(0, 8);
    return path.join(THUMBNAILS_DIR, `${hash}_${basename}.webp`);
  }
  
  return path.join(THUMBNAILS_DIR, `${basename}.webp`);
}

/**
 * Check if thumbnail exists for a file (and has content)
 */
function thumbnailExists(filename) {
  const thumbPath = getThumbnailPath(filename);
  if (!fs.existsSync(thumbPath)) {
    return false;
  }
  // Check file has actual content (not 0 bytes)
  const stats = fs.statSync(thumbPath);
  return stats.size > 0;
}

/**
 * Convert HEIC to JPEG using heic-convert
 * Returns { path, needsCleanup } - path to JPEG file, and whether it's a temp file
 * If file is already JPEG/PNG, returns original path with needsCleanup=false
 */
async function convertHeicToJpeg(heicPath, filename) {
  // Put temp file in thumbnails directory to avoid polluting Content folder
  // Handle full paths by extracting basename and adding hash for uniqueness
  const basename = path.basename(filename);
  let tempFilename;
  if (filename.includes('/') || filename.includes('\\')) {
    const hash = crypto.createHash('md5').update(filename).digest('hex').substring(0, 8);
    tempFilename = `${hash}_${basename}_temp.jpg`;
  } else {
    tempFilename = `${basename}_temp.jpg`;
  }
  const tempJpegPath = path.join(THUMBNAILS_DIR, tempFilename);

  try {
    const inputBuffer = fs.readFileSync(heicPath);
    const actualFormat = detectImageFormat(inputBuffer);
    
    // If it's already JPEG/PNG/etc (not actually HEIC), use Sharp directly
    if (actualFormat && actualFormat !== 'heic') {
      console.log(`File ${filename} has .heic extension but is actually ${actualFormat}, processing directly`);
      return { path: heicPath, needsCleanup: false, isAlreadyImage: true };
    }
    
    // Actual HEIC file - convert with heic-convert
    const outputBuffer = await heicConvert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 1
    });

    fs.writeFileSync(tempJpegPath, outputBuffer);
    return { path: tempJpegPath, needsCleanup: true, isAlreadyImage: false };
  } catch (error) {
    console.error(`HEIC conversion failed for ${heicPath}:`, error.message);
    return null;
  }
}

/**
 * Generate a thumbnail for an image file
 * Returns the thumbnail path on success, null on failure
 */
async function generateThumbnail(filename) {
  // Handle both relative filenames and full paths
  const sourcePath = (filename.includes('/') || filename.includes('\\')) 
    ? filename 
    : path.join(IMAGES_DIR, filename);
  if (!isResolvedPathInsideDir(sourcePath, IMAGES_DIR)) {
    console.warn(`Rejected thumbnail request outside images dir: ${filename}`);
    return null;
  }
  const thumbnailPath = getThumbnailPath(filename);

  // Skip if valid thumbnail already exists
  if (thumbnailExists(filename)) {
    return thumbnailPath;
  }

  // Delete empty/corrupt thumbnail if it exists
  if (fs.existsSync(thumbnailPath)) {
    try {
      fs.unlinkSync(thumbnailPath);
    } catch (e) {
      // File might be busy (being served), skip regeneration for now
      if (e.code === 'EBUSY') {
        return null;
      }
      // For other errors, log and continue
      console.warn(`Could not delete corrupt thumbnail ${filename}:`, e.code);
    }
  }

  // Skip if source doesn't exist
  if (!fs.existsSync(sourcePath)) {
    return null;
  }

  const ext = path.extname(filename).toLowerCase();
  let inputPath = sourcePath;
  let tempFile = null;

  try {
    // Read file and detect actual format
    const inputBuffer = fs.readFileSync(sourcePath);
    const actualFormat = detectImageFormat(inputBuffer);
    
    // Skip files with unknown/unsupported formats or videos
    if (!actualFormat || actualFormat === 'video') {
      if (!actualFormat) {
        console.warn(`Skipping ${filename}: Unknown image format`);
      }
      return null;
    }

    // For HEIC files, convert to JPEG first using heic-convert
    if (ext === '.heic' || actualFormat === 'heic') {
      const conversionResult = await convertHeicToJpeg(sourcePath, filename);
      if (!conversionResult) {
        return null;
      }
      inputPath = conversionResult.path;
      if (conversionResult.needsCleanup) {
        tempFile = conversionResult.path;
      }
    }

    // Generate thumbnail with sharp
    // Use buffer if we already have it (for non-HEIC) to avoid re-reading
    const sharpInput = inputPath === sourcePath ? inputBuffer : inputPath;
    
    await sharp(sharpInput)
      .resize(THUMBNAIL_WIDTH, null, {
        withoutEnlargement: true,
        fit: 'inside'
      })
      .webp({ quality: THUMBNAIL_QUALITY })
      .toFile(thumbnailPath);

    // Invalidate status cache so next request gets fresh count
    thumbnailStatusCache = null;
    
    return thumbnailPath;
  } catch (error) {
    // Don't spam logs for known problematic files
    if (!error.message.includes('unsupported image format')) {
      console.error(`Failed to generate thumbnail for ${filename}:`, error.message);
    }
    return null;
  } finally {
    // Clean up temp file if created
    if (tempFile && fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

// Scan progress state for SSE
let scanProgress = { current: 0, total: 0, phase: 'idle', scanning: false };
let progressListeners = [];
let firstScanDone = false;

function notifyProgressListeners() {
  progressListeners.forEach(res => {
    res.write(`data: ${JSON.stringify(scanProgress)}\n\n`);
  });
}

/**
 * Scan directory for photos using the configured metadata adapter
 * The adapter handles the specifics of how to find and extract metadata
 */
async function scanImages() {
  const now = Date.now();

  // Return cached data if still valid
  if (photoCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION) {
    return photoCache;
  }

  // Mark scan as in progress
  scanProgress = { current: 0, total: 0, phase: 'starting', scanning: true };
  notifyProgressListeners();

  // Use the metadata adapter to scan for photos
  const adapterInfo = metadataAdapter.getAdapterInfo();
  console.log(`Using adapter: ${adapterInfo.displayName}`);
  
  // Progress callback for SSE updates
  const onProgress = (current, total, phase) => {
    scanProgress = { current, total, phase, scanning: phase !== 'complete' };
    notifyProgressListeners();
  };
  
  const photos = await metadataAdapter.scanPhotos(IMAGES_DIR, PORT, onProgress);

  // Cache the results
  photoCache = photos;
  cacheTimestamp = now;

  // Mark scan as complete
  scanProgress = { current: photos.length, total: photos.length, phase: 'complete', scanning: false };
  notifyProgressListeners();

  // Start background thumbnail generation after first scan
  if (!firstScanDone) {
    firstScanDone = true;
    setTimeout(() => {
      console.log('🖼️  Starting background thumbnail generation...');
      startBackgroundThumbnailGeneration();
    }, 1000);
  }

  return photos;
}

// API Routes

/**
 * Get current adapter info
 */
app.get('/api/adapter', (req, res) => {
  const adapterInfo = metadataAdapter.getAdapterInfo();
  res.json(adapterInfo);
});

/**
 * SSE endpoint for scan progress
 */
app.get('/api/scan/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send current state immediately
  res.write(`data: ${JSON.stringify(scanProgress)}\n\n`);
  
  // Add to listeners
  progressListeners.push(res);
  
  // Remove on disconnect
  req.on('close', () => {
    progressListeners = progressListeners.filter(r => r !== res);
  });
});

/**
 * Get all photos metadata
 */
app.get('/api/photos', async (req, res) => {
  try {
    const photos = await scanImages();

    // Filter options
    const { withLocation, withMedia } = req.query;

    let filtered = photos;
    if (withLocation === 'true') {
      filtered = filtered.filter(p => p.hasLocation);
    }
    if (withMedia === 'true') {
      filtered = filtered.filter(p => p.hasMediaFile);
    }

    // Generate simple hash for cache invalidation
    // Based on count and latest photo date
    const latestDate = photos.length > 0 ? photos[photos.length - 1].date : '';
    const hash = `${photos.length}-${latestDate}`;

    res.json({
      total: photos.length,
      withLocation: photos.filter(p => p.hasLocation).length,
      withMedia: photos.filter(p => p.hasMediaFile).length,
      hash,  // For cache invalidation
      photos: filtered
    });
  } catch (error) {
    console.error('Error fetching photos:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

/**
 * Get single photo metadata
 */
app.get('/api/photos/:id', async (req, res) => {
  try {
    const photos = await scanImages();
    const photo = photos.find(p => p.id === parseInt(req.params.id));

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    res.json(photo);
  } catch (error) {
    console.error('Error fetching photo:', error);
    res.status(500).json({ error: 'Failed to fetch photo' });
  }
});

/**
 * Serve media files (HEIC, MOV, etc.) with thumbnail support
 */
app.get('/images/:filename', async (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  // If filename is already a path (i.e., contains a path separator), use it directly
  // Otherwise, use the default join
  let filePath;
  if (filename.includes('/') || filename.includes('\\')) {
    filePath = filename;
  } else {
    filePath = path.join(IMAGES_DIR, filename);
  }
  const wantsThumbnail = req.query.thumb === 'true';

  // Security: ensure we're not serving files outside the images directory
  if (!isResolvedPathInsideDir(filePath, IMAGES_DIR)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Media not found' });
  }

  const ext = path.extname(filename).toLowerCase();

  // Handle thumbnail requests for images
  if (wantsThumbnail && IMAGE_EXTENSIONS.includes(ext)) {
    const thumbnailPath = getThumbnailPath(filename);

    // Check if thumbnail already exists
    if (fs.existsSync(thumbnailPath)) {
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=604800'); // 1 week cache for thumbnails
      return res.sendFile(thumbnailPath);
    }

    // Generate thumbnail on-demand
    const generatedPath = await generateThumbnail(filename);
    if (generatedPath) {
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=604800');
      return res.sendFile(generatedPath);
    }

    // Fall through to serve original if thumbnail generation failed
    console.warn(`Thumbnail generation failed for ${filename}, serving original`);
  }

  // Serve original file, but convert HEIC if displaying full image
  if (ext === '.heic') {
    // If browser requesting image, it likely can't show HEIC
    // We convert it on the fly to JPEG
    try {
      const inputBuffer = fs.readFileSync(filePath);
      const actualFormat = detectImageFormat(inputBuffer);
      
      // If it's already JPEG/PNG/etc (mislabeled .heic file), serve with Sharp conversion
      if (actualFormat && actualFormat !== 'heic') {
        console.log(`Full image ${filename} has .heic extension but is actually ${actualFormat}`);
        const outputBuffer = await sharp(inputBuffer)
          .jpeg({ quality: 90 })
          .toBuffer();
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(outputBuffer);
      }
      
      // Unknown format - try Sharp first (it supports many formats)
      if (!actualFormat) {
        console.log(`Full image ${filename} has unknown format, trying Sharp...`);
        try {
          const outputBuffer = await sharp(inputBuffer)
            .jpeg({ quality: 90 })
            .toBuffer();
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=86400');
          return res.send(outputBuffer);
        } catch (sharpErr) {
          console.warn(`Sharp failed for ${filename}, trying heic-convert...`);
          // Fall through to heic-convert as last resort
        }
      }
      
      // Actual HEIC file - convert with heic-convert
      if (actualFormat === 'heic') {
        const outputBuffer = await heicConvert({
          buffer: inputBuffer,
          format: 'JPEG',
          quality: 0.9
        });
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(outputBuffer);
      }
    } catch (e) {
      console.error(`Failed to convert full HEIC ${filename}:`, e);
      // Fallback to sending original
    }
  }

  const contentTypes = {
    '.heic': 'image/heic',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.m4v': 'video/x-m4v'
  };

  if (contentTypes[ext]) {
    res.set('Content-Type', contentTypes[ext]);
  }

  // Set cache headers
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

/**
 * Force refresh the photo cache
 */
app.post('/api/refresh', async (req, res) => {
  photoCache = null;
  cacheTimestamp = null;
  const photos = await scanImages();
  res.json({ message: 'Cache refreshed', count: photos.length });
});

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Priority thumbnail generation - generate thumbnails for visible items first
 * Called by frontend when timeline scrolls
 */
app.post('/api/thumbnails/priority', express.json(), async (req, res) => {
  const { filenames, highPriority } = req.body;
  
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return res.json({ queued: 0 });
  }
  
  // Filter to only files that need thumbnails
  const needsGeneration = filenames.filter(filename => !thumbnailExists(filename));
  
  if (needsGeneration.length === 0) {
    return res.json({ queued: 0, message: 'All thumbnails already exist' });
  }
  
  if (highPriority) {
    // High priority (clicked photo) - prepend to front of queue
    priorityQueue = [...needsGeneration, ...priorityQueue.filter(f => !needsGeneration.includes(f))];
    console.log(`⚡ High priority thumbnail request: ${needsGeneration[0]}`);
  } else {
    // Normal priority (visible items) - replace queue
    priorityQueue = needsGeneration;
  }
  
  // Start priority processing if not already running
  if (!processingPriority) {
    processPriorityQueue();
  }
  
  res.json({ queued: needsGeneration.length, highPriority: !!highPriority });
});

/**
 * Process priority queue - generates thumbnails for visible items immediately
 */
async function processPriorityQueue() {
  if (processingPriority || priorityQueue.length === 0) {
    return;
  }
  
  processingPriority = true;
  
  while (priorityQueue.length > 0) {
    const filename = priorityQueue.shift();
    
    // Skip if already generated (might have been done by background worker)
    if (thumbnailExists(filename)) {
      continue;
    }
    
    await generateThumbnail(filename);
    
    // Yield to allow new priority requests to come in
    await new Promise(resolve => setImmediate(resolve));
  }
  
  processingPriority = false;
}

/**
 * Get thumbnail generation status (with caching for performance)
 */
app.get('/api/thumbnails/status', (req, res) => {
  const now = Date.now();
  const photos = photoCache || [];
  
  // Use cached status if available and fresh
  if (thumbnailStatusCache && thumbnailStatusCacheTime && 
      (now - thumbnailStatusCacheTime) < THUMBNAIL_STATUS_CACHE_DURATION) {
    // Update only the dynamic fields
    thumbnailStatusCache.inProgress = backgroundGenerationInProgress;
    return res.json(thumbnailStatusCache);
  }
  
  // Calculate fresh status (expensive operation)
  const imagePhotos = photos.filter(p => p.hasMediaFile && p.isImage);
  const generated = imagePhotos.filter(p => thumbnailExists(p.filename)).length;
  const percentage = imagePhotos.length > 0 ? Math.round((generated / imagePhotos.length) * 100) : 0;

  thumbnailStatusCache = {
    imagesDirectory: IMAGES_DIR,
    thumbnailsDirectory: THUMBNAILS_DIR,
    totalPhotos: photos.length,
    totalImages: imagePhotos.length,
    generated,
    pending: imagePhotos.length - generated,
    percentage,
    inProgress: backgroundGenerationInProgress,
    withLocation: photos.filter(p => p.hasLocation).length,
    withMedia: photos.filter(p => p.hasMediaFile).length
  };
  thumbnailStatusCacheTime = now;
  
  res.json(thumbnailStatusCache);
});

/**
 * Background thumbnail generation worker
 * Runs after server startup to pre-generate thumbnails
 */
async function startBackgroundThumbnailGeneration() {
  if (backgroundGenerationInProgress) {
    console.log('Background thumbnail generation already in progress');
    return;
  }

  backgroundGenerationInProgress = true;

  try {
    const photos = await scanImages();
    const imagePhotos = photos.filter(p => p.hasMediaFile && p.isImage);
    const needsThumbnail = imagePhotos.filter(p => !thumbnailExists(p.filename));

    if (needsThumbnail.length === 0) {
      console.log('✅ All thumbnails already generated');
      backgroundGenerationInProgress = false;
      return;
    }

    console.log(`🖼️  Background: Generating ${needsThumbnail.length} thumbnails...`);

    let generated = 0;
    let failed = 0;

    for (const photo of needsThumbnail) {
      // Check if priority queue has items - pause background work
      if (priorityQueue.length > 0) {
        console.log(`⏸️  Pausing background generation for ${priorityQueue.length} priority items...`);
        await processPriorityQueue();
        console.log(`▶️  Resuming background generation...`);
      }
      
      // Skip if already generated (might have been done by priority processing)
      if (thumbnailExists(photo.filename)) {
        continue;
      }
      
      const result = await generateThumbnail(photo.filename);

      if (result) {
        generated++;
      } else {
        failed++;
      }

      // Log progress every 10 thumbnails
      if ((generated + failed) % 10 === 0) {
        console.log(`   Progress: ${generated + failed}/${needsThumbnail.length} (${generated} success, ${failed} failed)`);
      }

      // Yield to event loop to allow HTTP requests to be processed
      await new Promise(resolve => setImmediate(resolve));
    }

    console.log(`✅ Background generation complete: ${generated} generated, ${failed} failed`);
  } catch (error) {
    console.error('Background thumbnail generation error:', error);
  } finally {
    backgroundGenerationInProgress = false;
  }
}

// Start server
app.listen(PORT, () => {
  const adapterInfo = metadataAdapter.getAdapterInfo();
  console.log(`\n🗺️  Photo Explorer Server running at http://localhost:${PORT}`);
  console.log(`📁 Serving media from: ${IMAGES_DIR}`);
  console.log(`🖼️  Thumbnails stored in: ${THUMBNAILS_DIR}`);
  console.log(`🔌 Metadata adapter: ${adapterInfo.displayName}`);
  console.log(`   ${adapterInfo.description}`);
  console.log(`\nAPI Endpoints:`);
  console.log(`  GET  /api/adapter             - Get adapter info`);
  console.log(`  GET  /api/photos              - List all photos`);
  console.log(`  GET  /api/photos?withLocation=true - Photos with GPS only`);
  console.log(`  GET  /api/photos?withMedia=true    - Photos with media files only`);
  console.log(`  GET  /api/photos/:id          - Get single photo`);
  console.log(`  GET  /images/:filename        - Serve media file`);
  console.log(`  GET  /images/:filename?thumb=true - Serve thumbnail`);
  console.log(`  GET  /api/thumbnails/status   - Thumbnail generation status`);
  console.log(`  POST /api/refresh             - Refresh cache\n`);

  // Note: We don't pre-scan at startup anymore
  // The scan is triggered by the first /api/photos request
  // This allows SSE progress listeners to connect first
  console.log('⏳ Ready - scan will start when first client connects\n');
});
