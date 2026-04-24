import React, { useEffect, useRef, useMemo, useCallback, memo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapView.css';

// Fix for default marker icons in react-leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

// Cache for marker icons to avoid recreating on every render
const iconCache = new Map();

function getPhotoIcon(isSelected, isVideo) {
  const key = `${isSelected}-${isVideo}`;
  if (iconCache.has(key)) {
    return iconCache.get(key);
  }
  
  const baseColor = isVideo ? '#7ee787' : '#58a6ff';
  const selectedColor = '#f778ba';
  
  const icon = L.divIcon({
    className: 'photo-marker',
    html: `
      <div class="marker-pin ${isSelected ? 'selected' : ''}" style="--marker-color: ${isSelected ? selectedColor : baseColor}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          ${isVideo ? 
            '<polygon points="5 3 19 12 5 21 5 3"></polygon>' :
            '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline>'
          }
        </svg>
      </div>
    `,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -36],
  });
  
  iconCache.set(key, icon);
  return icon;
}

// Simple marker without popup for clustering (better performance)
const ClusteredMarker = memo(function ClusteredMarker({ photo, onSelect }) {
  const icon = useMemo(
    () => getPhotoIcon(false, photo.isVideo),
    [photo.isVideo]
  );
  
  const handleClick = useCallback(() => {
    onSelect(photo);
  }, [photo, onSelect]);
  
  return (
    <Marker
      position={[photo.lat, photo.lng]}
      icon={icon}
      alt={photo.id}
      eventHandlers={{ click: handleClick }}
    />
  );
});

// Selected marker with popup (shown outside cluster)
const SelectedMarker = memo(function SelectedMarker({ photo, onSelect }) {
  const icon = useMemo(
    () => getPhotoIcon(true, photo.isVideo),
    [photo.isVideo]
  );
  
  const handleClick = useCallback(() => {
    onSelect(photo);
  }, [photo, onSelect]);
  
  return (
    <Marker
      position={[photo.lat, photo.lng]}
      icon={icon}
      alt={photo.id}
      eventHandlers={{ click: handleClick }}
      zIndexOffset={1000}
    >
      <Popup className="photo-popup">
        <div className="popup-content">
          {photo.hasMediaFile && photo.url ? (
            photo.isVideo ? (
              <div className="popup-video-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>Video</span>
              </div>
            ) : (
              <img src={photo.thumbnail} alt={photo.title} loading="lazy" />
            )
          ) : (
            <div className="popup-no-media">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="3" y1="3" x2="21" y2="21"></line>
              </svg>
              <span>No preview</span>
            </div>
          )}
          <div className="popup-info">
            <h4>{photo.title}</h4>
            <span className="popup-date">{photo.dateFormatted}</span>
          </div>
        </div>
      </Popup>
    </Marker>
  );
});

// Component to handle map view changes when selected photo changes
function MapViewController({ selectedPhoto, photos, isPreviewExpanded }) {
  const map = useMap();
  const hasInitialized = useRef(false);
  
  useEffect(() => {
    // Guard: ensure map is ready before performing operations
    if (!map) return;
    
    if (selectedPhoto && selectedPhoto.hasLocation) {
      const currentZoom = map.getZoom();
      const targetZoom = hasInitialized.current ? currentZoom : 14;
      
      // Calculate target position
      let targetLat = selectedPhoto.lat;
      let targetLng = selectedPhoto.lng;
      
      // When preview is expanded, offset the center so the marker appears
      // in the center of the visible (right) half of the map
      if (isPreviewExpanded) {
        const mapSize = map.getSize();
        if (mapSize && mapSize.x > 0) {
          const offsetX = mapSize.x / 4; 
          const photoPoint = map.project([selectedPhoto.lat, selectedPhoto.lng], targetZoom);
          const offsetPoint = L.point(photoPoint.x - offsetX, photoPoint.y);
          const offsetLatLng = map.unproject(offsetPoint, targetZoom);
          targetLat = offsetLatLng.lat;
          targetLng = offsetLatLng.lng;
        }
      }
      
      // Snappier movement
      map.setView([targetLat, targetLng], targetZoom, {
        animate: true,
        duration: 0.3
      });
      
      hasInitialized.current = true;
    } else if (photos.length > 0 && !hasInitialized.current) {
      const photosWithLocation = photos.filter(p => p.hasLocation);
      if (photosWithLocation.length > 0) {
        const bounds = L.latLngBounds(photosWithLocation.map(p => [p.lat, p.lng]));
        map.fitBounds(bounds, { padding: [50, 50] });
        hasInitialized.current = true;
      }
    }
  }, [selectedPhoto, photos, map, isPreviewExpanded]);
  
  return null;
}

// Memoized overlay component with expanded mode
const SelectedPhotoOverlay = memo(function SelectedPhotoOverlay({ photo, onClick, isExpanded, onToggleExpand }) {
  if (!photo) return null;
  
  const handleClick = (e) => {
    e.stopPropagation();
    if (!isExpanded) {
      onToggleExpand(true);
    }
  };
  
  const handleClose = (e) => {
    e.stopPropagation();
    onToggleExpand(false);
  };
  
  const handleOpenLightbox = (e) => {
    e.stopPropagation();
    onClick();
  };
  
  return (
    <div className={`selected-photo-overlay ${isExpanded ? 'expanded' : ''}`} onClick={handleClick} title={isExpanded ? '' : 'Click to enlarge'}>
      <div className={`overlay-image-container ${isExpanded ? 'expanded' : 'clickable'}`}>
        {isExpanded && (
          <div className="expanded-controls">
            <button className="expand-btn fullscreen" onClick={handleOpenLightbox} title="Open fullscreen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
            </button>
            <button className="expand-btn close" onClick={handleClose} title="Close preview">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        )}
        {photo.hasMediaFile && photo.url ? (
          photo.isVideo ? (
            <div className={`overlay-video-placeholder ${isExpanded ? 'expanded' : ''}`}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
              <span>Click fullscreen to play</span>
            </div>
          ) : (
            <img src={isExpanded ? photo.url : photo.thumbnail} alt={photo.title} loading="lazy" />
          )
        ) : (
          <div className={`overlay-no-media ${isExpanded ? 'expanded' : ''}`}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="3" y1="3" x2="21" y2="21"></line>
            </svg>
            <span>XMP metadata only</span>
          </div>
        )}
        <div className="overlay-info">
          <h3>{photo.title}</h3>
          <p>{photo.dateFormatted}</p>
          {photo.hasLocation && (
            <p className="location-text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                <circle cx="12" cy="10" r="3"></circle>
              </svg>
              {photo.location}
            </p>
          )}
          <div className="overlay-badges">
            {photo.isVideo && <span className="badge video">Video</span>}
            {!photo.hasMediaFile && <span className="badge xmp-only">XMP Only</span>}
          </div>
        </div>
      </div>
    </div>
  );
});

// Map layer definitions
const MAP_LAYERS = {
  street: {
    name: 'Street',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  },
  satellite: {
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
    maxZoom: 19
  },
  topo: {
    name: 'Terrain',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
    maxZoom: 17
  }
};

// Custom cluster icon creator
const createClusterCustomIcon = (cluster) => {
  const count = cluster.getChildCount();
  let size = 'small';
  let dimensions = 36;
  
  if (count >= 100) {
    size = 'large';
    dimensions = 50;
  } else if (count >= 10) {
    size = 'medium';
    dimensions = 42;
  }
  
  return L.divIcon({
    html: `<div class="cluster-marker cluster-${size}"><span>${count}</span></div>`,
    className: 'custom-cluster-icon',
    iconSize: L.point(dimensions, dimensions, true),
  });
};

// Individual item in the cluster popup with its own loading state
const ClusterPopupItem = memo(function ClusterPopupItem({ photo, onClick }) {
  const [isLoaded, setIsLoaded] = useState(false);
  
  return (
    <div 
      className={`cluster-popup-item ${photo.isVideo ? 'is-video' : ''}`}
      onClick={() => onClick(photo)}
      title={`${photo.title} - ${photo.dateFormatted}`}
    >
      {photo.hasMediaFile && photo.thumbnail && !photo.isVideo ? (
        <>
          <img 
            src={photo.thumbnail} 
            alt={photo.title} 
            loading="lazy"
            className={isLoaded ? 'loaded' : ''}
            onLoad={() => setIsLoaded(true)}
          />
          {!isLoaded && <div className="cluster-thumb-skeleton"></div>}
        </>
      ) : (
        <div className="cluster-thumb-placeholder">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            {photo.isVideo ? 
              <polygon points="5 3 19 12 5 21 5 3"></polygon> :
              <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle></>
            }
          </svg>
        </div>
      )}
      {photo.isVideo && (
        <div className="cluster-video-badge">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </div>
      )}
      <div className="cluster-item-info">
        <span className="cluster-item-date">{photo.dateShort}</span>
      </div>
    </div>
  );
});

// Cluster popup grid component
const ClusterPopup = memo(function ClusterPopup({ photos, onPhotoSelect, onClose }) {
  if (!photos || photos.length === 0) return null;
  
  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);
  
  const handlePhotoClick = useCallback((photo) => {
    onPhotoSelect(photo);
    onClose();
  }, [onPhotoSelect, onClose]);
  
  return (
    <div className="cluster-popup-overlay" onClick={onClose}>
      <div className="cluster-popup-container" onClick={(e) => e.stopPropagation()}>
        <div className="cluster-popup-header">
          <h3>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
            {photos.length} Photos at this location
          </h3>
          <button className="cluster-popup-close" onClick={onClose} title="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div className="cluster-popup-grid">
          {photos.map((photo) => (
            <ClusterPopupItem 
              key={photo.id} 
              photo={photo} 
              onClick={handlePhotoClick} 
            />
          ))}
        </div>
      </div>
    </div>
  );
});

function MapView({ photos, selectedPhoto, onPhotoSelect, pinMode, onOpenLightbox }) {
  const mapRef = useRef(null);
  const [mapLayer, setMapLayer] = useState('street');
  const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);
  const [clusterPhotos, setClusterPhotos] = useState(null); // Photos in clicked cluster
  
  // Memoize filtered photos (excluding selected to avoid duplicate)
  const photosWithLocation = useMemo(
    () => photos.filter(p => p.hasLocation),
    [photos]
  );
  
  // Photos for clustering (exclude selected photo)
  const clusterablePhotos = useMemo(
    () => photosWithLocation.filter(p => p.id !== selectedPhoto?.id),
    [photosWithLocation, selectedPhoto?.id]
  );
  
  // Build a map of photo ID to photo object for quick lookup
  const photoMap = useMemo(() => {
    const map = new Map();
    photos.forEach(p => map.set(p.id, p));
    return map;
  }, [photos]);
  
  // Memoize center calculation
  const center = useMemo(
    () => photosWithLocation.length > 0 
      ? [photosWithLocation[0].lat, photosWithLocation[0].lng] 
      : [-37.0, 175.0],
    [photosWithLocation]
  );
  
  // Stable callback reference
  const handleMarkerClick = useCallback((photo) => {
    onPhotoSelect(photo);
  }, [onPhotoSelect]);
  
  // Handle cluster click - show popup with photos
  const handleClusterClick = useCallback((cluster) => {
    // Get all markers in this cluster
    const markers = cluster.layer.getAllChildMarkers();
    
    // Extract photo data from markers using the stored ID in alt option
    // Use a Set to ensure we only include each photo once
    const seenIds = new Set();
    const clusterPhotoList = [];
    
    markers.forEach(marker => {
      const id = marker.options.alt;
      if (id && !seenIds.has(id)) {
        const photo = photoMap.get(id);
        if (photo) {
          seenIds.add(id);
          clusterPhotoList.push(photo);
        }
      }
    });
    
    // Sort by date
    clusterPhotoList.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    setClusterPhotos(clusterPhotoList);
  }, [photoMap]);
  
  const handleCloseClusterPopup = useCallback(() => {
    setClusterPhotos(null);
  }, []);

  const currentLayer = MAP_LAYERS[mapLayer];
  
  return (
    <div className="map-container">
      {/* Layer switcher */}
      <div className="map-layer-switcher">
        {Object.entries(MAP_LAYERS).map(([key, layer]) => (
          <button
            key={key}
            className={`layer-btn ${mapLayer === key ? 'active' : ''}`}
            onClick={() => setMapLayer(key)}
            title={layer.name}
          >
            {key === 'street' && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
            )}
            {key === 'satellite' && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="2" y1="12" x2="22" y2="12"></line>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
              </svg>
            )}
            {key === 'topo' && (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.5 10c-.83 0-1.5-.67-1.5-1.5v-5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5z"></path>
                <path d="M20.5 10H19V8.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"></path>
                <path d="M9.5 14c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5S8 21.33 8 20.5v-5c0-.83.67-1.5 1.5-1.5z"></path>
                <path d="M3.5 14H5v1.5c0 .83-.67 1.5-1.5 1.5S2 16.33 2 15.5 2.67 14 3.5 14z"></path>
                <path d="M14 14.5c0-.83.67-1.5 1.5-1.5h5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-5c-.83 0-1.5-.67-1.5-1.5z"></path>
                <path d="M15.5 19H14v1.5c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5z"></path>
                <path d="M10 9.5C10 8.67 9.33 8 8.5 8h-5C2.67 8 2 8.67 2 9.5S2.67 11 3.5 11h5c.83 0 1.5-.67 1.5-1.5z"></path>
                <path d="M8.5 5H10V3.5C10 2.67 9.33 2 8.5 2S7 2.67 7 3.5 7.67 5 8.5 5z"></path>
              </svg>
            )}
            <span>{layer.name}</span>
          </button>
        ))}
      </div>

      <MapContainer
        center={center}
        zoom={10}
        ref={mapRef}
        className="leaflet-map"
      >
        <TileLayer
          key={mapLayer}
          url={currentLayer.url}
          attribution={currentLayer.attribution}
          maxZoom={currentLayer.maxZoom}
        />
        
        <MapViewController selectedPhoto={selectedPhoto} photos={photos} isPreviewExpanded={isPreviewExpanded} />
        
        {pinMode === 'all' && (
          <>
            {/* Clustered markers for better performance */}
            <MarkerClusterGroup
              chunkedLoading
              iconCreateFunction={createClusterCustomIcon}
              maxClusterRadius={60}
              spiderfyOnMaxZoom={false}
              showCoverageOnHover={false}
              zoomToBoundsOnClick={false}
              disableClusteringAtZoom={18}
              onClick={handleClusterClick}
            >
              {clusterablePhotos.map((photo) => (
                <ClusteredMarker
                  key={photo.id}
                  photo={photo}
                  onSelect={handleMarkerClick}
                />
              ))}
            </MarkerClusterGroup>
            
            {/* Selected marker always visible outside cluster */}
            {selectedPhoto && selectedPhoto.hasLocation && (
              <SelectedMarker
                photo={selectedPhoto}
                onSelect={handleMarkerClick}
              />
            )}
          </>
        )}
        
        {pinMode === 'single' && selectedPhoto && selectedPhoto.hasLocation && (
          <SelectedMarker
            photo={selectedPhoto}
            onSelect={handleMarkerClick}
          />
        )}
        
        {/* pinMode === 'none' shows no markers */}
      </MapContainer>
      
      <SelectedPhotoOverlay 
        photo={selectedPhoto} 
        onClick={onOpenLightbox} 
        isExpanded={isPreviewExpanded}
        onToggleExpand={setIsPreviewExpanded}
      />
      
      {/* Cluster photo grid popup */}
      {clusterPhotos && clusterPhotos.length > 0 && (
        <ClusterPopup 
          photos={clusterPhotos}
          onPhotoSelect={onPhotoSelect}
          onClose={handleCloseClusterPopup}
        />
      )}
    </div>
  );
}

export default memo(MapView);
