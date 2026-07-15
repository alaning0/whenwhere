import React, { useState, useEffect, useMemo, useCallback, useDeferredValue, useRef } from 'react';
import MapView from './components/MapView';
import Timeline from './components/Timeline';
import ListView from './components/ListView';
import GridView from './components/GridView';
import Lightbox from './components/Lightbox';
import StatusPopover from './components/StatusPopover';
import Settings from './components/Settings';
import { getCachedPhotos, setCachedPhotos, getCacheMetadata, clearCache } from './services/photoCache';
import { API_URL } from './config';
import './App.css';

function selectDefaultPhoto(photoList, setSelectedPhoto) {
  const firstWithLocationAndMedia = photoList.find(p => p.hasLocation && p.hasMediaFile);
  if (firstWithLocationAndMedia) {
    setSelectedPhoto(firstWithLocationAndMedia);
  } else {
    const firstWithLocation = photoList.find(p => p.hasLocation);
    if (firstWithLocation) {
      setSelectedPhoto(firstWithLocation);
    } else if (photoList.length > 0) {
      setSelectedPhoto(photoList[0]);
    } else {
      setSelectedPhoto(null);
    }
  }
}

function App() {
  const [viewMode, setViewMode] = useState('map');
  const [photos, setPhotos] = useState([]);
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [pinMode, setPinMode] = useState('all'); // 'none', 'single', 'all'
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({
    current: 0,
    total: 0,
    phase: 'idle',
    scanning: false,
  });
  const [error, setError] = useState(null);
  const [showOnlyWithLocation, setShowOnlyWithLocation] = useState(true);
  const [showOnlyWithMedia, setShowOnlyWithMedia] = useState(true);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [sseReady, setSseReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [needsConfig, setNeedsConfig] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const loadAbortRef = useRef(null);
  const loadGenerationRef = useRef(0);
  const hadSelectionRef = useRef(false);
  const progressKeyRef = useRef('');

  // Long-lived scan progress SSE
  useEffect(() => {
    const eventSource = new EventSource(`${API_URL}/api/scan/progress`);

    eventSource.onopen = () => {
      setSseReady(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setScanProgress(data);
        setScanning(Boolean(data.scanning));
      } catch (err) {
        console.error('Failed to parse scan progress:', err);
      }
    };

    eventSource.onerror = () => {
      // Allow the app to proceed even if SSE fails
      setSseReady(true);
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const applyPhotosResponse = useCallback((data, { selectIfEmpty = false } = {}) => {
    if (data.needsConfig) {
      setNeedsConfig(true);
      setSettingsOpen(true);
      setPhotos([]);
      setSelectedPhoto(null);
      setScanning(false);
      setSyncing(false);
      return;
    }

    setNeedsConfig(false);
    if (typeof data.scanning === 'boolean') {
      setScanning(data.scanning);
      setSyncing(data.scanning);
    }

    const freshPhotos = data.photos || [];
    setPhotos(freshPhotos);

    if (selectIfEmpty || !hadSelectionRef.current) {
      if (freshPhotos.length > 0) {
        selectDefaultPhoto(freshPhotos, setSelectedPhoto);
        hadSelectionRef.current = true;
      }
    }

    if (!data.scanning && freshPhotos.length > 0 && data.hash) {
      setCachedPhotos(freshPhotos, data.hash);
    }
  }, []);

  // Initial / reload photo fetch
  useEffect(() => {
    if (!sseReady) return;

    const generation = ++loadGenerationRef.current;
    const abortController = new AbortController();
    loadAbortRef.current = abortController;

    async function loadPhotos() {
      let hadCachedPhotos = false;
      try {
        setError(null);

        const cachedPhotos = await getCachedPhotos();

        if (cachedPhotos && cachedPhotos.length > 0) {
          hadCachedPhotos = true;
          console.log(`Loaded ${cachedPhotos.length} photos from cache`);
          setPhotos(cachedPhotos);
          selectDefaultPhoto(cachedPhotos, setSelectedPhoto);
          hadSelectionRef.current = true;
          setLoading(false);
          setSyncing(true);
        }

        const response = await fetch(`${API_URL}/api/photos`, {
          signal: abortController.signal,
        });
        if (generation !== loadGenerationRef.current) return;
        if (!response.ok) {
          throw new Error('Failed to fetch photos');
        }

        const data = await response.json();
        if (generation !== loadGenerationRef.current) return;

        const cacheMetadata = await getCacheMetadata();
        if (generation !== loadGenerationRef.current) return;

        const needsUpdate = !cacheMetadata || cacheMetadata.hash !== data.hash || data.scanning;

        if (needsUpdate || !hadCachedPhotos) {
          applyPhotosResponse(data, { selectIfEmpty: !hadCachedPhotos });
        } else {
          console.log('Cache is up to date');
          if (typeof data.scanning === 'boolean') {
            setScanning(data.scanning);
            setSyncing(data.scanning);
          } else {
            setSyncing(false);
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Error fetching photos:', err);
        if (!hadCachedPhotos) {
          setError(err.message);
        }
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
        }
      }
    }

    loadPhotos();

    return () => {
      abortController.abort();
    };
  }, [sseReady, reloadToken, applyPhotosResponse]);

  // While scanning, refetch photos when SSE progress advances (debounced)
  useEffect(() => {
    if (!sseReady || loading) return;

    const isActive = scanProgress.scanning || scanning;
    if (!isActive && scanProgress.phase !== 'complete') return;

    const key = `${scanProgress.phase}:${scanProgress.current}:${scanProgress.total}:${scanProgress.scanning}`;
    if (key === progressKeyRef.current) return;
    progressKeyRef.current = key;

    // Always do a final fetch when scan completes
    const shouldRefetch =
      scanProgress.scanning ||
      scanProgress.phase === 'processing' ||
      scanProgress.phase === 'complete' ||
      scanProgress.phase === 'sorting';

    if (!shouldRefetch) return;

    const timeoutId = setTimeout(async () => {
      const generation = loadGenerationRef.current;
      try {
        const response = await fetch(`${API_URL}/api/photos`);
        if (generation !== loadGenerationRef.current) return;
        if (!response.ok) return;
        const data = await response.json();
        if (generation !== loadGenerationRef.current) return;
        applyPhotosResponse(data);
        if (!data.scanning) {
          setSyncing(false);
        }
      } catch (err) {
        console.error('Failed to refresh photos during scan:', err);
      }
    }, scanProgress.phase === 'complete' ? 50 : 500);

    return () => clearTimeout(timeoutId);
  }, [sseReady, loading, scanProgress, scanning, applyPhotosResponse]);

  const handleSettingsSaved = useCallback(async () => {
    await clearCache();
    setNeedsConfig(false);
    setSettingsOpen(false);
    setPhotos([]);
    setSelectedPhoto(null);
    hadSelectionRef.current = false;
    progressKeyRef.current = '';
    setScanning(true);
    setSyncing(true);
    setLoading(false);
    setReloadToken((token) => token + 1);
  }, []);

  const handleChooseDifferentFolder = useCallback(async () => {
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();

    try {
      await fetch(`${API_URL}/api/scan/cancel`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to cancel scan:', err);
    }

    setPhotos([]);
    setSelectedPhoto(null);
    hadSelectionRef.current = false;
    setScanning(false);
    setSyncing(false);
    setLoading(false);
    setSettingsOpen(true);
  }, []);

  // Debounced priority thumbnail request
  const requestPriorityThumbnails = useMemo(
    () => {
      let timeoutId;
      return (filename) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
          fetch(`${API_URL}/api/thumbnails/priority`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: [filename], highPriority: true }),
          }).catch(err => console.error('Failed to prioritize thumbnail:', err));
        }, 150);
      };
    },
    []
  );

  const handlePhotoSelect = useCallback((photo) => {
    setSelectedPhoto(photo);
    hadSelectionRef.current = true;

    if (photo && photo.hasMediaFile && photo.isImage) {
      requestPriorityThumbnails(photo.filename);
    }
  }, [requestPriorityThumbnails]);

  const handlePinModeChange = useCallback((mode) => {
    setPinMode(mode);
  }, []);

  const setMapView = useCallback(() => setViewMode('map'), []);
  const setListView = useCallback(() => setViewMode('list'), []);
  const setGridView = useCallback(() => setViewMode('grid'), []);

  const openLightbox = useCallback(() => {
    setLightboxOpen(true);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxOpen(false);
  }, []);

  const handleLightboxNavigate = useCallback((photo) => {
    setSelectedPhoto(photo);
  }, []);

  const photosForMap = useMemo(() => {
    let result = photos;
    if (showOnlyWithLocation) {
      result = result.filter(p => p.hasLocation);
    }
    if (showOnlyWithMedia) {
      result = result.filter(p => p.hasMediaFile);
    }
    return result;
  }, [photos, showOnlyWithLocation, showOnlyWithMedia]);

  const deferredPhotosForMap = useDeferredValue(photosForMap);
  const isFiltering = photosForMap !== deferredPhotosForMap;

  const photosWithLocation = useMemo(
    () => photos.filter(p => p.hasLocation),
    [photos]
  );

  const photosWithMedia = useMemo(
    () => photos.filter(p => p.hasMediaFile),
    [photos]
  );

  useEffect(() => {
    if (lightboxOpen) return;

    const handleKeyDown = (e) => {
      if (viewMode !== 'map') return;

      const currentIndex = deferredPhotosForMap.findIndex(p => p.id === selectedPhoto?.id);

      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        setSelectedPhoto(deferredPhotosForMap[currentIndex - 1]);
      } else if (e.key === 'ArrowRight' && currentIndex < deferredPhotosForMap.length - 1) {
        setSelectedPhoto(deferredPhotosForMap[currentIndex + 1]);
      } else if (e.key === 'Enter' && selectedPhoto) {
        setLightboxOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [lightboxOpen, viewMode, deferredPhotosForMap, selectedPhoto]);

  if (loading) {
    return (
      <div className="app loading-screen">
        <div className="loading-content">
          <div className="loading-spinner"></div>
          <h2>Connecting…</h2>
          <p>Starting WhenWhere</p>
        </div>
        <Settings
          open={settingsOpen}
          required={needsConfig}
          onClose={() => {
            if (!needsConfig) setSettingsOpen(false);
          }}
          onSaved={handleSettingsSaved}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="app error-screen">
        <div className="error-content">
          <div className="error-icon">⚠️</div>
          <h2>Connection Error</h2>
          <p>{error}</p>
          <p className="error-hint">Make sure the backend server is running on port 3002</p>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    );
  }

  const showWorking = syncing || scanning || isFiltering;

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <div className="logo">
            <div className="logo-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="10" r="3"></circle>
                <path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 1 0-16 0c0 3 2.7 6.9 8 11.7z"></path>
              </svg>
            </div>
            <span className="logo-text">WhenWhere</span>
            {showWorking && (
              <span
                className="sync-indicator"
                title={
                  isFiltering
                    ? 'Filtering photos based on current selection...'
                    : scanning
                      ? 'Reading photo metadata in the background...'
                      : 'Loading updated photo data from server...'
                }
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
              </span>
            )}
          </div>
        </div>

        <nav className="view-switcher">
          <button
            className={`view-btn ${viewMode === 'map' ? 'active' : ''}`}
            onClick={setMapView}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
              <line x1="8" y1="2" x2="8" y2="18"></line>
              <line x1="16" y1="6" x2="16" y2="22"></line>
            </svg>
            <span>Map</span>
          </button>

          <button
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={setListView}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6"></line>
              <line x1="8" y1="12" x2="21" y2="12"></line>
              <line x1="8" y1="18" x2="21" y2="18"></line>
              <line x1="3" y1="6" x2="3.01" y2="6"></line>
              <line x1="3" y1="12" x2="3.01" y2="12"></line>
              <line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
            <span>List</span>
          </button>

          <button
            className={`view-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={setGridView}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7"></rect>
              <rect x="14" y="3" width="7" height="7"></rect>
              <rect x="14" y="14" width="7" height="7"></rect>
              <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
            <span>Grid</span>
          </button>
        </nav>

        <div className="header-right">
          <div className="photo-stats">
            <span className="stat" title="Total photos">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              {photos.length}
            </span>
            <span className="stat location" title="With GPS data">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
              {photosWithLocation.length}
            </span>
            <span className="stat media" title="With media files">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              {photosWithMedia.length}
            </span>
          </div>
          <button
            type="button"
            className="settings-trigger"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <StatusPopover
            scanProgress={scanProgress}
            scanning={scanning}
            onChooseDifferentFolder={handleChooseDifferentFolder}
          />
        </div>
      </header>

      <main className="app-main">
        {viewMode === 'map' && (
          <div className="map-layout">
            {(deferredPhotosForMap.length > 0 || scanning) ? (
              <MapView
                photos={deferredPhotosForMap}
                selectedPhoto={selectedPhoto}
                onPhotoSelect={handlePhotoSelect}
                pinMode={pinMode}
                onOpenLightbox={openLightbox}
                emptyMessage={
                  deferredPhotosForMap.length === 0
                    ? (scanning
                      ? 'Scanning photo library… Photos with GPS will appear as they are found.'
                      : null)
                    : null
                }
              />
            ) : (
              <div className="no-location-message">
                <div className="message-content">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  <h3>No Photos to Display</h3>
                  <p>No photos match the current filters.</p>
                  <p className="hint">Try adjusting filters or check if XMP files contain GPS data.</p>
                </div>
              </div>
            )}
            <Timeline
              photos={deferredPhotosForMap.length > 0 ? deferredPhotosForMap : photos}
              selectedPhoto={selectedPhoto}
              onPhotoSelect={handlePhotoSelect}
              pinMode={pinMode}
              onPinModeChange={handlePinModeChange}
            />
          </div>
        )}

        {viewMode === 'list' && (
          <ListView
            photos={photos}
            selectedPhoto={selectedPhoto}
            onPhotoSelect={handlePhotoSelect}
            onOpenLightbox={openLightbox}
          />
        )}

        {viewMode === 'grid' && (
          <GridView
            photos={photos}
            selectedPhoto={selectedPhoto}
            onPhotoSelect={handlePhotoSelect}
            onOpenLightbox={openLightbox}
          />
        )}
      </main>

      {lightboxOpen && (
        <Lightbox
          photo={selectedPhoto}
          photos={viewMode === 'map' ? deferredPhotosForMap : photos}
          onClose={closeLightbox}
          onNavigate={handleLightboxNavigate}
        />
      )}

      <Settings
        open={settingsOpen}
        required={needsConfig}
        onClose={() => {
          if (!needsConfig) setSettingsOpen(false);
        }}
        onSaved={handleSettingsSaved}
      />
    </div>
  );
}

export default App;
