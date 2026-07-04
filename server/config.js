/**
 * WhenWhere Server Configuration
 *
 * Loads settings from config.json (app-written) with optional .env fallback
 * for development. Config is mutable at runtime for in-app settings.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Apply CLI overrides before any config is read (Electron passes these)
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  const next = process.argv[i + 1];
  if (arg === '--static-dir' && next) {
    process.env.WHENWHERE_STATIC_DIR = next;
    i++;
  } else if (arg === '--config-dir' && next) {
    process.env.WHENWHERE_CONFIG_DIR = next;
    i++;
  } else if (arg === '--port' && next) {
    process.env.PORT = next;
    i++;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_ADAPTERS = ['exif', 'xmp', 'google-takeout'];

/** Directory for config.json — Electron sets WHENWHERE_CONFIG_DIR to userData */
function getConfigDir() {
  if (process.env.WHENWHERE_CONFIG_DIR) {
    return process.env.WHENWHERE_CONFIG_DIR;
  }
  return __dirname;
}

function getConfigFilePath() {
  return path.join(getConfigDir(), 'config.json');
}

function getEnvFilePath() {
  return path.join(__dirname, '.env');
}

function envTrim(name) {
  const v = process.env[name];
  return v == null ? '' : String(v).trim();
}

/**
 * Load key=value pairs from a .env file into process.env (does not overwrite).
 */
function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

function resolvePath(pathValue) {
  if (!pathValue) return '';
  const value = String(pathValue).trim();
  if (!value) return '';
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(__dirname, value);
}

function defaultThumbnailsDir(imagesDir) {
  if (!imagesDir) return '';
  return path.join(imagesDir, '.thumbnails');
}

function normalizeAdapter(adapter) {
  if (VALID_ADAPTERS.includes(adapter)) return adapter;
  if (adapter) {
    console.warn(`Warning: Unknown adapter "${adapter}", defaulting to "exif"`);
  }
  return 'exif';
}

/**
 * Runtime config state
 */
let state = {
  adapter: 'exif',
  imagesDir: '',
  thumbnailsDir: '',
  port: 3002,
};

function applyState({ adapter, imagesDir, thumbnailsDir, port }) {
  const resolvedImages = resolvePath(imagesDir);
  let resolvedThumbs = resolvePath(thumbnailsDir);
  if (resolvedImages && !resolvedThumbs) {
    resolvedThumbs = defaultThumbnailsDir(resolvedImages);
  }

  state = {
    adapter: normalizeAdapter(adapter),
    imagesDir: resolvedImages,
    thumbnailsDir: resolvedThumbs,
    port: port != null ? parseInt(port, 10) || 3002 : state.port,
  };
}

/**
 * Load .env then config.json (config.json wins for user settings).
 */
function load() {
  loadEnvFile(getEnvFilePath());

  const fromEnv = {
    adapter: process.env.ADAPTER || 'exif',
    imagesDir: envTrim('IMAGES_DIR'),
    thumbnailsDir: envTrim('THUMBNAILS_DIR'),
    port: parseInt(process.env.PORT, 10) || 3002,
  };

  const configPath = getConfigFilePath();
  let fromFile = null;
  if (fs.existsSync(configPath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      console.warn(`Warning: Could not parse ${configPath}:`, err.message);
    }
  }

  applyState({
    adapter: fromFile?.adapter ?? fromEnv.adapter,
    imagesDir: fromFile?.imagesDir ?? fromEnv.imagesDir,
    thumbnailsDir: fromFile?.thumbnailsDir ?? fromEnv.thumbnailsDir,
    port: fromFile?.port ?? fromEnv.port,
  });

  return getConfig();
}

function persist() {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const payload = {
    adapter: state.adapter,
    imagesDir: state.imagesDir,
    thumbnailsDir: state.thumbnailsDir,
  };

  fs.writeFileSync(getConfigFilePath(), JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Public snapshot of current config.
 */
export function getConfig() {
  return {
    adapter: state.adapter,
    imagesDir: state.imagesDir,
    thumbnailsDir: state.thumbnailsDir,
    port: state.port,
    configured: Boolean(state.imagesDir),
    configPath: getConfigFilePath(),
  };
}

export function isConfigured() {
  return Boolean(state.imagesDir);
}

export function getImagesDir() {
  return state.imagesDir;
}

export function getThumbnailsDir() {
  return state.thumbnailsDir;
}

export function getPort() {
  return state.port;
}

export function getAdapterName() {
  return state.adapter;
}

export function getValidAdapters() {
  return [...VALID_ADAPTERS];
}

/**
 * Update and persist config. Returns the new config snapshot.
 * @throws {Error} on validation failure
 */
export function updateConfig({ adapter, imagesDir, thumbnailsDir }) {
  const nextAdapter = adapter != null ? normalizeAdapter(adapter) : state.adapter;
  const nextImages = imagesDir != null ? resolvePath(imagesDir) : state.imagesDir;

  if (!nextImages) {
    throw new Error('Photos folder is required');
  }

  if (!fs.existsSync(nextImages)) {
    throw new Error(`Photos folder does not exist: ${nextImages}`);
  }

  const imagesStat = fs.statSync(nextImages);
  if (!imagesStat.isDirectory()) {
    throw new Error(`Photos path is not a directory: ${nextImages}`);
  }

  let nextThumbs =
    thumbnailsDir != null && String(thumbnailsDir).trim()
      ? resolvePath(thumbnailsDir)
      : defaultThumbnailsDir(nextImages);

  applyState({
    adapter: nextAdapter,
    imagesDir: nextImages,
    thumbnailsDir: nextThumbs,
    port: state.port,
  });

  try {
    fs.mkdirSync(state.thumbnailsDir, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create thumbnails folder: ${err.message}`);
  }

  persist();
  return getConfig();
}

// Initialize on import
load();

export default {
  getConfig,
  isConfigured,
  getImagesDir,
  getThumbnailsDir,
  getPort,
  getAdapterName,
  getValidAdapters,
  updateConfig,
  load,
};
