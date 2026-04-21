/**
 * WhenWhere Server Configuration
 * 
 * Loads configuration from environment variables with sensible defaults.
 * Copy .env.example to .env and customize for your setup.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file if it exists (simple implementation without dotenv dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
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

/**
 * Resolve a path that may be relative or absolute
 * Relative paths are resolved from the server directory
 */
function resolvePath(pathValue, defaultPath) {
  const value = pathValue || defaultPath;
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(__dirname, value);
}

const config = {
  // Which adapter to use: 'exif', 'xmp', or 'google-takeout'
  adapter: process.env.ADAPTER || 'exif',
  
  // Directory containing photos and media files
  imagesDir: resolvePath(process.env.IMAGES_DIR, path.join(__dirname, '..', 'Content')),
  
  // Directory for storing generated thumbnails
  thumbnailsDir: resolvePath(process.env.THUMBNAILS_DIR, path.join(__dirname, '..', '.thumbnails')),
  
  // Server port
  port: parseInt(process.env.PORT, 10) || 3002,
};

// Validate configuration
if (!['exif', 'xmp', 'google-takeout'].includes(config.adapter)) {
  console.warn(`Warning: Unknown adapter "${config.adapter}", defaulting to "exif"`);
  config.adapter = 'exif';
}

export default config;
