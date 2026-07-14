import express from 'express';
import cors from 'cors';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
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
import { ScanCancelledError } from './adapters/utils.js';

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

const app = express();

// The server binds to loopback only; CORS is needed solely for the CRA dev server origin.
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000'] }));
app.use(express.json());

/**
 * Express 4 does not catch rejections from async handlers — an uncaught throw
 * would crash the process on Node >= 15. Route errors become 500s instead.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Thumbnail settings
const THUMBNAIL_WIDTH = 300;
const THUMBNAIL_QUALITY = 80;
const THUMBNAIL_CONCURRENCY = 4;

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
let photoCacheMeta = null; // { hash, withLocation, withMedia } computed once per scan
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000;

// Single-flight scan state. scanEpoch invalidates in-flight scans when the
// config changes: a scan that started under the old config must not publish
// its results, progress, or side effects after resetRuntimeState().
let scanEpoch = 0;
let scanPromise = null;
let backgroundThumbnailTimer = null;

let backgroundGenerationInProgress = false;

let thumbnailStatusCache = null;
let thumbnailStatusCacheTime = null;
const THUMBNAIL_STATUS_CACHE_DURATION = 30000;

let priorityQueue = [];
let processingPriority = false;

function resetRuntimeState() {
  scanEpoch++;
  scanPromise = null;
  if (backgroundThumbnailTimer) {
    clearTimeout(backgroundThumbnailTimer);
    backgroundThumbnailTimer = null;
  }
  photoCache = null;
  photoCacheMeta = null;
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
  try {
    const stats = await fsp.stat(getThumbnailPath(filename));
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

// Full-size HEIC conversion costs seconds of CPU and ~50MB+ peak memory per
// 12MP image. Convert once to disk, cap concurrency so a lightbox arrow-key
// spree cannot stack conversions, and share in-flight jobs per output path.
const FULL_CONVERT_CONCURRENCY = 2;
let fullConvertActive = 0;
const fullConvertWaiters = [];
const inFlightFullConversions = new Map();

function acquireConvertSlot() {
  if (fullConvertActive < FULL_CONVERT_CONCURRENCY) {
    fullConvertActive++;
    return Promise.resolve();
  }
  return new Promise(resolve => fullConvertWaiters.push(resolve));
}

function releaseConvertSlot() {
  const next = fullConvertWaiters.shift();
  if (next) {
    next(); // hand the slot to the next waiter
  } else {
    fullConvertActive--;
  }
}

function getConvertedFullPath(filename) {
  const hash = crypto.createHash('md5').update(filename).digest('hex').slice(0, 12);
  return path.join(getThumbnailsDir(), 'full', `${hash}_${path.basename(filename)}.jpg`);
}

/**
 * Return the path of a full-size JPEG conversion of the given HEIC,
 * converting and caching it on first request. Returns null on failure so the
 * route can fall back to serving the raw file.
 */
async function getConvertedHeic(sourcePath, filename) {
  const outPath = getConvertedFullPath(filename);
  const existing = await fsp.stat(outPath).catch(() => null);
  if (existing && existing.size > 0) {
    return outPath;
  }

  if (inFlightFullConversions.has(outPath)) {
    return inFlightFullConversions.get(outPath);
  }

  const job = (async () => {
    await acquireConvertSlot();
    try {
      // Another request may have finished it while we waited for a slot
      const raced = await fsp.stat(outPath).catch(() => null);
      if (raced && raced.size > 0) {
        return outPath;
      }
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      try {
        await sharp(sourcePath, { failOnError: false })
          .rotate()
          .jpeg({ quality: 90 })
          .toFile(outPath);
        return outPath;
      } catch (e) {
        console.log(`Sharp failed for full image ${filename}, attempting heic-convert fallback...`);
        try {
          const buffer = await fsp.readFile(sourcePath);
          const jpegBuffer = await convertHeicBufferToJpeg(buffer);
          if (!jpegBuffer) {
            console.error(`Failed to convert full HEIC ${filename}:`, e.message);
            return null;
          }
          await fsp.writeFile(outPath, jpegBuffer);
          return outPath;
        } catch (fallbackErr) {
          console.error(`Fallback failed for ${filename}:`, fallbackErr.message);
          return null;
        }
      }
    } finally {
      releaseConvertSlot();
    }
  })().finally(() => inFlightFullConversions.delete(outPath));

  inFlightFullConversions.set(outPath, job);
  return job;
}

// Concurrent requests for the same thumbnail share one generation job —
// two writers on the same output path would corrupt it.
const inFlightThumbnails = new Map();

async function generateThumbnail(filename) {
  const thumbnailPath = getThumbnailPath(filename);
  if (inFlightThumbnails.has(thumbnailPath)) {
    return inFlightThumbnails.get(thumbnailPath);
  }
  const job = generateThumbnailInner(filename, thumbnailPath)
    .finally(() => inFlightThumbnails.delete(thumbnailPath));
  inFlightThumbnails.set(thumbnailPath, job);
  return job;
}

async function generateThumbnailInner(filename, thumbnailPath) {
  const imagesDir = getImagesDir();
  const sourcePath = (filename.includes('/') || filename.includes('\\'))
    ? filename
    : path.join(imagesDir, filename);
  if (!isResolvedPathInsideDir(sourcePath, imagesDir)) {
    console.warn(`Rejected thumbnail request outside images dir: ${filename}`);
    return null;
  }

  const existing = await fsp.stat(thumbnailPath).catch(() => null);
  if (existing) {
    if (existing.size > 0) {
      return thumbnailPath;
    }
    // Zero-byte thumbnail from an interrupted write — regenerate it
    try {
      await fsp.unlink(thumbnailPath);
    } catch (e) {
      if (e.code === 'EBUSY') {
        return null;
      }
      console.warn(`Could not delete corrupt thumbnail ${filename}:`, e.code);
    }
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

/**
 * Signature of the current photo set, computed once per scan.
 * Content-derived (id + size + date per photo) so edits and replacements are
 * detected even when the photo count stays the same.
 */
function computeCacheMeta(photos) {
  const hashInput = photos.map(p => `${p.id}:${p.size}:${p.date}`).sort().join('\n');
  return {
    hash: `v2-${crypto.createHash('md5').update(hashInput).digest('hex').slice(0, 16)}`,
    withLocation: photos.reduce((n, p) => n + (p.hasLocation ? 1 : 0), 0),
    withMedia: photos.reduce((n, p) => n + (p.hasMediaFile ? 1 : 0), 0),
  };
}

/**
 * Run one full adapter scan. All published state (cache, progress, background
 * thumbnail scheduling) is gated on the epoch so a scan that a config change
 * made stale cannot leak old-directory results into the new configuration.
 */
async function runScan(epoch) {
  try {
    scanProgress = { current: 0, total: 0, phase: 'starting', scanning: true };
    notifyProgressListeners();

    const adapterInfo = metadataAdapter.getAdapterInfo();
    console.log(`Using adapter: ${adapterInfo.displayName}`);

    const onProgress = (current, total, phase) => {
      if (epoch !== scanEpoch) return; // stale scan: stop broadcasting
      scanProgress = { current, total, phase, scanning: phase !== 'complete' };
      notifyProgressListeners();
    };

    const photos = await metadataAdapter.scanPhotos(getImagesDir(), getPort(), onProgress, {
      excludeDirs: [getThumbnailsDir()],
      isCancelled: () => epoch !== scanEpoch,
    });

    if (epoch !== scanEpoch) {
      // Config changed mid-scan — discard instead of caching stale results
      return photos;
    }

    photoCache = photos;
    photoCacheMeta = computeCacheMeta(photos);
    cacheTimestamp = Date.now();

    scanProgress = { current: photos.length, total: photos.length, phase: 'complete', scanning: false };
    notifyProgressListeners();

    if (!firstScanDone) {
      firstScanDone = true;
      backgroundThumbnailTimer = setTimeout(() => {
        backgroundThumbnailTimer = null;
        console.log('🖼️  Starting background thumbnail generation...');
        startBackgroundThumbnailGeneration();
      }, 1000);
    }

    return photos;
  } catch (err) {
    if (err instanceof ScanCancelledError || epoch !== scanEpoch) {
      return [];
    }
    if (epoch === scanEpoch) {
      scanProgress = { current: 0, total: 0, phase: 'idle', scanning: false };
      notifyProgressListeners();
    }
    throw err;
  }
}

/**
 * Get the photo list. Single-flight with stale-while-revalidate:
 *  - fresh cache: returned as-is
 *  - scan in flight: existing cache if present, otherwise join the scan
 *  - stale cache: returned immediately while one background rescan refreshes it
 */
async function scanImages() {
  if (!isConfigured()) {
    return [];
  }

  if (photoCache && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_DURATION) {
    return photoCache;
  }

  if (scanPromise) {
    return photoCache || scanPromise;
  }

  const epoch = scanEpoch;
  const promise = runScan(epoch).finally(() => {
    if (scanPromise === promise) {
      scanPromise = null;
    }
  });
  scanPromise = promise;

  if (photoCache) {
    // Serve stale data now; the background rescan updates the cache when done
    promise.catch(err => console.error('Background rescan failed:', err.message));
    return photoCache;
  }

  return promise;
}

// API Routes

app.get('/api/config', (req, res) => {
  const config = getConfig();
  res.json({
    ...config,
    adapters: getValidAdapters(),
  });
});

app.put('/api/config', asyncHandler(async (req, res) => {
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
}));

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

app.post('/api/scan/cancel', (req, res) => {
  resetRuntimeState();
  res.json({ cancelled: true });
});

app.get('/api/photos', asyncHandler(async (req, res) => {
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

    // Reuse the per-scan metadata unless we were handed a non-cached result
    // (e.g. a scan that finished after a config change)
    const meta = (photos === photoCache && photoCacheMeta)
      ? photoCacheMeta
      : computeCacheMeta(photos);

    res.json({
      total: photos.length,
      withLocation: meta.withLocation,
      withMedia: meta.withMedia,
      hash: meta.hash,
      needsConfig: false,
      photos: filtered
    });
  } catch (error) {
    console.error('Error fetching photos:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
}));

app.get('/api/photos/:id', asyncHandler(async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const photos = await scanImages();
    const photo = photos.find(p => p.id === req.params.id);

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    res.json(photo);
  } catch (error) {
    console.error('Error fetching photo:', error);
    res.status(500).json({ error: 'Failed to fetch photo' });
  }
}));

app.get('/images/:filename', asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'Not configured' });
  }

  // Express has already percent-decoded the param; decoding again corrupts
  // names with literal "%" and can throw on sequences like "50%.jpg".
  const filename = req.params.filename;
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
    const convertedPath = await getConvertedHeic(filePath, filename);
    if (convertedPath) {
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.sendFile(convertedPath);
    }
    // Conversion failed — fall through to serving the raw HEIC
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
}));

app.post('/api/refresh', asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    return res.json({ message: 'Not configured', count: 0 });
  }
  // Null the cache first so the scan logic cannot serve the cache we are busting
  photoCache = null;
  cacheTimestamp = null;
  const photos = await scanImages();
  res.json({ message: 'Cache refreshed', count: photos.length });
}));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: isConfigured(),
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/thumbnails/priority', asyncHandler(async (req, res) => {
  if (!isConfigured()) {
    return res.json({ queued: 0 });
  }

  const { filenames, highPriority } = req.body || {};

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
}));

async function processPriorityQueue() {
  if (processingPriority || priorityQueue.length === 0) {
    return;
  }

  processingPriority = true;

  const processNext = async () => {
    while (priorityQueue.length > 0) {
      const filename = priorityQueue.shift();
      if (!(await thumbnailExists(filename))) {
        await generateThumbnail(filename);
      }
    }
  };

  const workers = Array(Math.min(THUMBNAIL_CONCURRENCY, priorityQueue.length))
    .fill(null)
    .map(() => processNext());

  await Promise.all(workers);

  processingPriority = false;
}

app.get('/api/thumbnails/status', asyncHandler(async (req, res) => {
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
    withLocation: photoCacheMeta ? photoCacheMeta.withLocation : 0,
    withMedia: photoCacheMeta ? photoCacheMeta.withMedia : 0
  };
  thumbnailStatusCacheTime = now;

  res.json(thumbnailStatusCache);
}));

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

        // generateThumbnail rechecks existence itself; the extra stat per
        // photo here was redundant (the list is already thumbSet-filtered)
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
 * Serve packaged React build.
 * Prefer WHENWHERE_STATIC_DIR; fall back to resources/build next to the server
 * (packaged layout: resources/server + resources/build).
 */
function resolveStaticDir() {
  const candidates = [
    process.env.WHENWHERE_STATIC_DIR,
    path.join(__dirname, '..', 'build'),
    path.join(__dirname, '..', '..', 'build'),
  ].filter(Boolean);

  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (fs.existsSync(path.join(resolved, 'index.html'))) {
      return resolved;
    }
  }
  return null;
}

function mountStaticFrontend() {
  const staticDir = resolveStaticDir();
  if (!staticDir) {
    console.warn('⚠️  No frontend build found (set WHENWHERE_STATIC_DIR or package resources/build)');
    return;
  }

  app.use(express.static(staticDir));
  app.get(/^(?!\/api(?:\/|$)|\/images(?:\/|$)).*/, (req, res) => {
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
    // Loopback only: this server exposes the photo library and an unauthenticated
    // config API, so it must never be reachable from the network.
    serverInstance = app.listen(port, '127.0.0.1', async () => {
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
