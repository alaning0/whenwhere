import express from 'express';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import {
  getConfig,
  isConfigured,
  getImagesDir,
  getThumbnailsDir,
  getPort,
  getAdapterName,
  getValidAdapters,
  updateConfig,
} from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const adapterMap = {
  exif: './adapters/exifAdapter.js',
  xmp: './adapters/xmpAdapter.js',
  'google-takeout': './adapters/GooglePhotosTakeoutAdapter.js',
};

let metadataAdapter = null;
const loadedAdapters = {};

async function loadAdapter(name) {
  const key = adapterMap[name] ? name : 'exif';
  if (!loadedAdapters[key]) {
    loadedAdapters[key] = await import(adapterMap[key]);
  }
  metadataAdapter = loadedAdapters[key];
  return metadataAdapter;
}

// Load initial adapter (default exif even when unconfigured)
await loadAdapter(getAdapterName());

function getImageExtensions() {
  return metadataAdapter.IMAGE_EXTENSIONS;
}

function getVideoExtensions() {
  return metadataAdapter.VIDEO_EXTENSIONS;
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

const execAsync = promisify(exec);

const app = express();

app.use(cors());
app.use(express.json());

// Thumbnail settings
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_QUALITY = 80;
const THUMBNAIL_CONCURRENCY = 2;

/**
 * Detect actual image format by reading magic bytes
 */
function detectImageFormat(buffer) {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpeg';
  }

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png';
  }

  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'gif';
  }

  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }

  if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
      (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)) {
    return 'tiff';
  }

  if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return 'bmp';
  }

  if (buffer.length >= 12) {
    const ftyp = buffer.slice(4, 8).toString('ascii');
    if (ftyp === 'ftyp') {
      const brand = buffer.slice(8, 12).toString('ascii');
      if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
        return 'heic';
      }
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
const CACHE_DURATION = 60000;

let backgroundGenerationInProgress = false;

let thumbnailStatusCache = null;
let thumbnailStatusCacheTime = null;
const THUMBNAIL_STATUS_CACHE_DURATION = 30000;

let priorityQueue = [];
let processingPriority = false;

function resetRuntimeState() {
  photoCache = null;
  cacheTimestamp = null;
  thumbnailStatusCache = null;
  thumbnailStatusCacheTime = null;
  priorityQueue = [];
  processingPriority = false;
  backgroundGenerationInProgress = false;
  firstScanDone = false;
  scanProgress = { current: 0, total: 0, phase: 'idle', scanning: false };
  notifyProgressListeners();
}

function getThumbnailPath(filename) {
  const thumbnailsDir = getThumbnailsDir();
  const basename = path.basename(filename);

  if (filename.includes('/') || filename.includes('\\')) {
    const hash = crypto.createHash('md5').update(filename).digest('hex').substring(0, 8);
    return path.join(thumbnailsDir, `${hash}_${basename}.webp`);
  }

  return path.join(thumbnailsDir, `${basename}.webp`);
}

async function thumbnailExists(filename) {
  const thumbPath = getThumbnailPath(filename);
  try {
    await fsp.access(thumbPath, fs.constants.F_OK);
    const stats = await fsp.stat(thumbPath);
    return stats.size > 0;
  } catch (e) {
    return false;
  }
}

async function convertHeicBufferToJpeg(buffer) {
  try {
    return await heicConvert({
      buffer: buffer,
      format: 'JPEG',
      quality: 1
    });
  } catch (error) {
    console.error('heic-convert fallback failed:', error.message);
    return null;
  }
}

async function generateThumbnail(filename) {
  const imagesDir = getImagesDir();
  const sourcePath = (filename.includes('/') || filename.includes('\\'))
    ? filename
    : path.join(imagesDir, filename);
  if (!isResolvedPathInsideDir(sourcePath, imagesDir)) {
    console.warn(`Rejected thumbnail request outside images dir: ${filename}`);
    return null;
  }
  const thumbnailPath = getThumbnailPath(filename);

  if (await thumbnailExists(filename)) {
    return thumbnailPath;
  }

  try {
    await fsp.access(thumbnailPath, fs.constants.F_OK);
    try {
      await fsp.unlink(thumbnailPath);
    } catch (e) {
      if (e.code === 'EBUSY') {
        return null;
      }
      console.warn(`Could not delete corrupt thumbnail ${filename}:`, e.code);
    }
  } catch (e) {
    // Thumbnail doesn't exist
  }

  try {
    await fsp.access(sourcePath, fs.constants.F_OK);
  } catch (e) {
    return null;
  }

  const ext = path.extname(filename).toLowerCase();

  try {
    if (getVideoExtensions().includes(ext)) {
      return null;
    }

    const buffer = await fsp.readFile(sourcePath);

    try {
      await sharp(buffer, { failOnError: false })
        .rotate()
        .resize(THUMBNAIL_WIDTH, null, {
          withoutEnlargement: true,
          fit: 'inside'
        })
        .webp({ quality: THUMBNAIL_QUALITY })
        .toFile(thumbnailPath);
    } catch (sharpError) {
      if (ext === '.heic' || sharpError.message.includes('heif') || sharpError.message.includes('seek')) {
        console.log(`Sharp failed for ${filename} (${sharpError.message}), attempting heic-convert fallback...`);
        const jpegBuffer = await convertHeicBufferToJpeg(buffer);
        if (jpegBuffer) {
          await sharp(jpegBuffer)
            .resize(THUMBNAIL_WIDTH, null, {
              withoutEnlargement: true,
              fit: 'inside'
            })
            .webp({ quality: THUMBNAIL_QUALITY })
            .toFile(thumbnailPath);
        } else {
          throw sharpError;
        }
      } else {
        throw sharpError;
      }
    }

    thumbnailStatusCache = null;

    return thumbnailPath;
  } catch (error) {
    if (!error.message.includes('unsupported image format')) {
      console.error(`Failed to generate thumbnail for ${filename}:`, error.message);
    }
    return null;
  }
}

let scanProgress = { current: 0, total: 0, phase: 'idle', scanning: false };
let progressListeners = [];
let firstScanDone = false;

function notifyProgressListeners() {
  progressListeners.forEach(res => {
    res.write(`data: ${JSON.stringify(scanProgress)}\n\n`);
  });
}

async function scanImages() {
  if (!isConfigured()) {
    return [];
  }

  const now = Date.now();

  if (photoCache && cacheTimestamp && (now - cacheTimestamp) < CACHE_DURATION) {
    return photoCache;
  }

  scanProgress = { current: 0, total: 0, phase: 'starting', scanning: true };
  notifyProgressListeners();

  const adapterInfo = metadataAdapter.getAdapterInfo();
  console.log(`Using adapter: ${adapterInfo.displayName}`);

  const onProgress = (current, total, phase) => {
    scanProgress = { current, total, phase, scanning: phase !== 'complete' };
    notifyProgressListeners();
  };

  const photos = await metadataAdapter.scanPhotos(getImagesDir(), getPort(), onProgress);

  photoCache = photos;
  cacheTimestamp = now;

  scanProgress = { current: photos.length, total: photos.length, phase: 'complete', scanning: false };
  notifyProgressListeners();

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

app.get('/api/config', (req, res) => {
  const config = getConfig();
  res.json({
    ...config,
    adapters: getValidAdapters(),
  });
});

app.put('/api/config', async (req, res) => {
  try {
    const { adapter, imagesDir, thumbnailsDir } = req.body || {};
    const previousAdapter = getAdapterName();
    const config = updateConfig({ adapter, imagesDir, thumbnailsDir });

    if (config.adapter !== previousAdapter) {
      await loadAdapter(config.adapter);
    }

    resetRuntimeState();

    res.json({
      ...config,
      adapters: getValidAdapters(),
      message: 'Configuration saved',
    });
  } catch (error) {
    console.error('Config update failed:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/adapter', (req, res) => {
  if (!metadataAdapter) {
    return res.status(503).json({ error: 'Adapter not loaded' });
  }
  const adapterInfo = metadataAdapter.getAdapterInfo();
  res.json(adapterInfo);
});

app.get('/api/scan/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.write(`data: ${JSON.stringify(scanProgress)}\n\n`);

  progressListeners.push(res);

  req.on('close', () => {
    progressListeners = progressListeners.filter(r => r !== res);
  });
});

app.get('/api/photos', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.json({
        total: 0,
        withLocation: 0,
        withMedia: 0,
        hash: 'unconfigured',
        needsConfig: true,
        photos: [],
      });
    }

    const photos = await scanImages();

    const { withLocation, withMedia } = req.query;

    let filtered = photos;
    if (withLocation === 'true') {
      filtered = filtered.filter(p => p.hasLocation);
    }
    if (withMedia === 'true') {
      filtered = filtered.filter(p => p.hasMediaFile);
    }

    const latestDate = photos.length > 0 ? photos[photos.length - 1].date : '';
    const hash = `${photos.length}-${latestDate}`;

    res.json({
      total: photos.length,
      withLocation: photos.filter(p => p.hasLocation).length,
      withMedia: photos.filter(p => p.hasMediaFile).length,
      hash,
      needsConfig: false,
      photos: filtered
    });
  } catch (error) {
    console.error('Error fetching photos:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

app.get('/api/photos/:id', async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(404).json({ error: 'Photo not found' });
    }

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

app.get('/images/:filename', async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Not configured' });
  }

  const filename = decodeURIComponent(req.params.filename);
  const imagesDir = getImagesDir();
  let filePath;
  if (filename.includes('/') || filename.includes('\\')) {
    filePath = filename;
  } else {
    filePath = path.join(imagesDir, filename);
  }
  const wantsThumbnail = req.query.thumb === 'true';

  if (!isResolvedPathInsideDir(filePath, imagesDir)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch (e) {
    return res.status(404).json({ error: 'Media not found' });
  }

  const ext = path.extname(filename).toLowerCase();

  if (wantsThumbnail && getImageExtensions().includes(ext)) {
    const thumbnailPath = getThumbnailPath(filename);

    try {
      await fsp.access(thumbnailPath, fs.constants.F_OK);
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=604800');
      return res.sendFile(thumbnailPath);
    } catch (e) {
      // generate below
    }

    const generatedPath = await generateThumbnail(filename);
    if (generatedPath) {
      res.set('Content-Type', 'image/webp');
      res.set('Cache-Control', 'public, max-age=604800');
      return res.sendFile(generatedPath);
    }

    console.warn(`Thumbnail generation failed for ${filename}, serving original`);
  }

  if (ext === '.heic') {
    try {
      const outputBuffer = await sharp(filePath, { failOnError: false })
        .rotate()
        .jpeg({ quality: 90 })
        .toBuffer();
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(outputBuffer);
    } catch (e) {
      console.log(`Sharp failed for full image ${filename}, attempting heic-convert fallback...`);
      try {
        const buffer = await fsp.readFile(filePath);
        const jpegBuffer = await convertHeicBufferToJpeg(buffer);
        if (jpegBuffer) {
          res.set('Content-Type', 'image/jpeg');
          res.set('Cache-Control', 'public, max-age=86400');
          return res.send(jpegBuffer);
        }
      } catch (fallbackErr) {
        console.error(`Fallback failed for ${filename}:`, fallbackErr.message);
      }
      console.error(`Failed to convert full HEIC ${filename}:`, e.message);
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

  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

app.post('/api/refresh', async (req, res) => {
  if (!isConfigured()) {
    return res.json({ message: 'Not configured', count: 0 });
  }
  photoCache = null;
  cacheTimestamp = null;
  const photos = await scanImages();
  res.json({ message: 'Cache refreshed', count: photos.length });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: isConfigured(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/thumbnails/priority', async (req, res) => {
  if (!isConfigured()) {
    return res.json({ queued: 0 });
  }

  const { filenames, highPriority } = req.body;

  if (!Array.isArray(filenames) || filenames.length === 0) {
    return res.json({ queued: 0 });
  }

  const needsGeneration = await Promise.all(filenames.map(async filename => {
    const exists = await thumbnailExists(filename);
    return exists ? null : filename;
  })).then(results => results.filter(Boolean));

  if (needsGeneration.length === 0) {
    return res.json({ queued: 0, message: 'All thumbnails already exist' });
  }

  if (highPriority) {
    priorityQueue = [...needsGeneration, ...priorityQueue.filter(f => !needsGeneration.includes(f))];
    console.log(`⚡ High priority thumbnail request: ${needsGeneration[0]}`);
  } else {
    priorityQueue = needsGeneration;
  }

  if (!processingPriority) {
    processPriorityQueue();
  }

  res.json({ queued: needsGeneration.length, highPriority: !!highPriority });
});

async function processPriorityQueue() {
  if (processingPriority || priorityQueue.length === 0) {
    return;
  }

  processingPriority = true;

  const processNext = async () => {
    if (priorityQueue.length === 0) return;

    const filename = priorityQueue.shift();

    if (!(await thumbnailExists(filename))) {
      await generateThumbnail(filename);
    }

    await processNext();
  };

  const workers = Array(Math.min(THUMBNAIL_CONCURRENCY, priorityQueue.length))
    .fill(null)
    .map(() => processNext());

  await Promise.all(workers);

  processingPriority = false;
}

app.get('/api/thumbnails/status', async (req, res) => {
  if (!isConfigured()) {
    return res.json({
      imagesDirectory: '',
      thumbnailsDirectory: '',
      totalPhotos: 0,
      totalImages: 0,
      generated: 0,
      pending: 0,
      percentage: 0,
      inProgress: false,
      withLocation: 0,
      withMedia: 0,
    });
  }

  const now = Date.now();
  const photos = photoCache || [];
  const thumbnailsDir = getThumbnailsDir();
  const imagesDir = getImagesDir();

  if (thumbnailStatusCache && thumbnailStatusCacheTime &&
      (now - thumbnailStatusCacheTime) < THUMBNAIL_STATUS_CACHE_DURATION) {
    thumbnailStatusCache.inProgress = backgroundGenerationInProgress;
    return res.json(thumbnailStatusCache);
  }

  const imagePhotos = photos.filter(p => p.hasMediaFile && p.isImage);

  let generated = 0;
  try {
    const thumbFiles = await fsp.readdir(thumbnailsDir);
    const thumbSet = new Set(thumbFiles);

    generated = imagePhotos.filter(p => {
      const thumbPath = getThumbnailPath(p.filename);
      return thumbSet.has(path.basename(thumbPath));
    }).length;
  } catch (error) {
    console.error('Error reading thumbnails directory:', error);
  }

  const percentage = imagePhotos.length > 0 ? Math.round((generated / imagePhotos.length) * 100) : 0;

  thumbnailStatusCache = {
    imagesDirectory: imagesDir,
    thumbnailsDirectory: thumbnailsDir,
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

async function startBackgroundThumbnailGeneration() {
  if (!isConfigured()) {
    return;
  }

  if (backgroundGenerationInProgress) {
    console.log('Background thumbnail generation already in progress');
    return;
  }

  backgroundGenerationInProgress = true;

  try {
    const photos = await scanImages();
    const imagePhotos = photos.filter(p => p.hasMediaFile && p.isImage);
    const thumbnailsDir = getThumbnailsDir();

    const thumbFiles = await fsp.readdir(thumbnailsDir).catch(() => []);
    const thumbSet = new Set(thumbFiles);

    const needsThumbnail = imagePhotos.filter(p => {
      const thumbPath = getThumbnailPath(p.filename);
      return !thumbSet.has(path.basename(thumbPath));
    });

    if (needsThumbnail.length === 0) {
      console.log('✅ All thumbnails already generated');
      backgroundGenerationInProgress = false;
      return;
    }

    console.log(`🖼️  Background: Generating ${needsThumbnail.length} thumbnails using ${THUMBNAIL_CONCURRENCY} workers...`);

    let generated = 0;
    let failed = 0;
    let index = 0;

    const processNext = async () => {
      while (index < needsThumbnail.length) {
        if (priorityQueue.length > 0) {
          await processPriorityQueue();
        }

        const photo = needsThumbnail[index++];
        if (!photo) break;

        if (await thumbnailExists(photo.filename)) {
          continue;
        }

        const result = await generateThumbnail(photo.filename);

        if (result) {
          generated++;
        } else {
          failed++;
        }

        if ((generated + failed) % 20 === 0) {
          console.log(`   Progress: ${generated + failed}/${needsThumbnail.length} (${generated} success, ${failed} failed)`);
        }
      }
    };

    const workers = Array(THUMBNAIL_CONCURRENCY).fill(null).map(() => processNext());
    await Promise.all(workers);

    console.log(`✅ Background generation complete: ${generated} generated, ${failed} failed`);
  } catch (error) {
    console.error('Background thumbnail generation error:', error);
  } finally {
    backgroundGenerationInProgress = false;
  }
}

/**
 * Serve packaged React build when WHENWHERE_STATIC_DIR is set.
 */
function mountStaticFrontend() {
  const staticDir = process.env.WHENWHERE_STATIC_DIR;
  if (!staticDir || !fs.existsSync(staticDir)) {
    return;
  }

  app.use(express.static(staticDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/images')) {
      return next();
    }
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  console.log(`📦 Serving frontend from: ${staticDir}`);
}

let serverInstance = null;

/**
 * Start the HTTP server. Safe to call from Electron or CLI.
 */
export async function startServer(options = {}) {
  if (serverInstance) {
    return serverInstance;
  }

  mountStaticFrontend();

  const port = options.port || getPort();

  return new Promise((resolve, reject) => {
    serverInstance = app.listen(port, async () => {
      const config = getConfig();

      if (config.thumbnailsDir) {
        await fsp.mkdir(config.thumbnailsDir, { recursive: true }).catch(err => {
          if (err.code !== 'EEXIST') console.warn('Could not create thumbnails dir:', err.message);
        });
      }

      console.log(`\n🗺️  WhenWhere Server running at http://localhost:${port}`);
      if (config.configured) {
        const adapterInfo = metadataAdapter.getAdapterInfo();
        console.log(`📁 Serving media from: ${config.imagesDir}`);
        console.log(`🖼️  Thumbnails stored in: ${config.thumbnailsDir}`);
        console.log(`🔌 Metadata adapter: ${adapterInfo.displayName}`);
      } else {
        console.log(`⚙️  Not configured yet — set photos folder in the app settings`);
      }
      console.log(`💾 Config file: ${config.configPath}`);
      console.log(`\nAPI Endpoints:`);
      console.log(`  GET  /api/config              - Get configuration`);
      console.log(`  PUT  /api/config              - Update configuration`);
      console.log(`  GET  /api/adapter             - Get adapter info`);
      console.log(`  GET  /api/photos              - List all photos`);
      console.log(`  POST /api/refresh             - Refresh cache\n`);
      console.log('⏳ Ready - scan will start when first client connects\n');

      resolve({ app, server: serverInstance, port });
    });

    serverInstance.on('error', reject);
  });
}

export { app };

// Auto-start when run directly (node server/index.js)
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
