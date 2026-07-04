/**
 * IndexedDB Photo Cache Service
 * Provides instant loading by caching photo metadata locally
 */

const DB_NAME = 'whenwhere-cache';
// v2: photo ids changed from positional numbers to stable strings
const DB_VERSION = 2;
const PHOTOS_STORE = 'photos';
const META_STORE = 'metadata';

let db = null;

/**
 * Initialize IndexedDB database
 */
export async function initDB() {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('Failed to open IndexedDB:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Store for photo metadata
      if (!database.objectStoreNames.contains(PHOTOS_STORE)) {
        database.createObjectStore(PHOTOS_STORE, { keyPath: 'id' });
      }

      // Store for cache metadata (hash, timestamp)
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' });
      }

      // v1 -> v2: drop cached data with old numeric ids
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        const transaction = event.target.transaction;
        transaction.objectStore(PHOTOS_STORE).clear();
        transaction.objectStore(META_STORE).clear();
      }
    };
  });
}

/**
 * Get cached photos from IndexedDB
 * Returns null if cache is empty
 */
export async function getCachedPhotos() {
  try {
    await initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(PHOTOS_STORE, 'readonly');
      const store = transaction.objectStore(PHOTOS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        const photos = request.result;
        if (photos && photos.length > 0) {
          // IndexedDB returns records in primary key (id) order, not insertion order.
          // Re-sort by date (ISO strings — lexicographic == chronological),
          // with the id as a tiebreak to match the server's ordering.
          photos.sort((a, b) => {
            if (a.date < b.date) return -1;
            if (a.date > b.date) return 1;
            if (a.id < b.id) return -1;
            if (a.id > b.id) return 1;
            return 0;
          });
          resolve(photos);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error('Failed to get cached photos:', request.error);
        resolve(null);
      };
    });
  } catch (error) {
    console.error('Cache read error:', error);
    return null;
  }
}

/**
 * Store photos in IndexedDB cache
 */
export async function setCachedPhotos(photos, hash) {
  try {
    await initDB();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([PHOTOS_STORE, META_STORE], 'readwrite');
      const photosStore = transaction.objectStore(PHOTOS_STORE);
      const metaStore = transaction.objectStore(META_STORE);

      // Clear existing photos
      photosStore.clear();

      // Add all photos
      photos.forEach(photo => {
        photosStore.add(photo);
      });

      // Store metadata
      metaStore.put({
        key: 'cache-info',
        hash: hash,
        count: photos.length,
        timestamp: Date.now()
      });

      transaction.oncomplete = () => {
        resolve(true);
      };

      transaction.onerror = () => {
        console.error('Failed to cache photos:', transaction.error);
        resolve(false);
      };
    });
  } catch (error) {
    console.error('Cache write error:', error);
    return false;
  }
}

/**
 * Get cache metadata (hash, count, timestamp)
 */
export async function getCacheMetadata() {
  try {
    await initDB();

    return new Promise((resolve) => {
      const transaction = db.transaction(META_STORE, 'readonly');
      const store = transaction.objectStore(META_STORE);
      const request = store.get('cache-info');

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        resolve(null);
      };
    });
  } catch (error) {
    return null;
  }
}

/**
 * Check if cache is valid (not too old)
 * Cache expires after 24 hours
 */
export async function isCacheValid() {
  const meta = await getCacheMetadata();
  if (!meta) return false;

  const ONE_DAY = 24 * 60 * 60 * 1000;
  const age = Date.now() - meta.timestamp;
  
  return age < ONE_DAY;
}

/**
 * Clear the cache
 */
export async function clearCache() {
  try {
    await initDB();

    return new Promise((resolve) => {
      const transaction = db.transaction([PHOTOS_STORE, META_STORE], 'readwrite');
      transaction.objectStore(PHOTOS_STORE).clear();
      transaction.objectStore(META_STORE).clear();

      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => resolve(false);
    });
  } catch (error) {
    return false;
  }
}
