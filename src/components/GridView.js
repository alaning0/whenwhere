import React, { useMemo, useCallback, memo, useRef, useEffect, useState } from 'react';
import { FixedSizeGrid as Grid } from 'react-window';
import { API_URL } from '../config';
import './GridView.css';

// Debounce helper
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

// Grid item dimensions
const ITEM_WIDTH = 160;
const ITEM_HEIGHT = 180;
const GAP = 12;

// Memoized grid cell renderer.
// No hooks in here: cells flip between empty (trailing cells) and populated
// as the grid resizes, and a conditional hook would crash the render.
const GridCell = memo(function GridCell({ columnIndex, rowIndex, style, data }) {
  const { photos, columns, selectedId, onSelect, onOpenLightbox } = data;
  const index = rowIndex * columns + columnIndex;

  if (index >= photos.length) {
    return null;
  }

  const photo = photos[index];
  const isSelected = photo.id === selectedId;

  const handleClick = () => {
    onSelect(photo);
    onOpenLightbox();
  };
  
  return (
    <div style={{
      ...style,
      left: style.left + GAP,
      top: style.top + GAP,
      width: style.width - GAP,
      height: style.height - GAP,
    }}>
      <div
        className={`grid-item ${isSelected ? 'selected' : ''} ${photo.isVideo ? 'is-video' : ''}`}
        onClick={handleClick}
      >
        <div className="grid-item-image">
          {photo.hasMediaFile && photo.thumbnail && !photo.isVideo ? (
            <>
              <div className="grid-loading-skeleton"></div>
              <img 
                src={photo.thumbnail} 
                alt={photo.title} 
                loading="lazy"
                onLoad={(e) => e.target.classList.add('loaded')}
              />
            </>
          ) : (
            <div className="grid-placeholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                {photo.isVideo ? 
                  <polygon points="5 3 19 12 5 21 5 3"></polygon> :
                  <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></>
                }
              </svg>
              {!photo.hasMediaFile && <span>XMP Only</span>}
            </div>
          )}
          <div className="grid-item-overlay">
            <div className="overlay-content">
              <span className="overlay-date">
                {photo.dateShort}, {new Date(photo.date).getFullYear()}
              </span>
              <span className="overlay-time">
                {photo.timeFormatted}
              </span>
              {photo.hasLocation && (
                <span className="overlay-location">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  GPS
                </span>
              )}
            </div>
          </div>
          {photo.isVideo && (
            <div className="video-indicator">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </div>
          )}
        </div>
        
        <div className="grid-item-info">
          <h4>{photo.title}</h4>
          <span className="grid-item-date">{photo.dateShort}, {new Date(photo.date).getFullYear()}</span>
        </div>
      </div>
    </div>
  );
});

function GridView({ photos, selectedPhoto, onPhotoSelect, onOpenLightbox }) {
  const containerRef = useRef(null);
  const gridRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Photos are already sorted by date from server - no need to re-sort!

  // Calculate grid columns based on container width
  const columns = useMemo(() => {
    return Math.max(1, Math.floor((dimensions.width - GAP) / ITEM_WIDTH));
  }, [dimensions.width]);

  // Calculate rows needed
  const rows = useMemo(() => {
    return Math.ceil(photos.length / columns);
  }, [photos.length, columns]);

  // Item data for virtualized grid
  const itemData = useMemo(() => ({
    photos,
    columns,
    selectedId: selectedPhoto?.id,
    onSelect: onPhotoSelect,
    onOpenLightbox
  }), [photos, columns, selectedPhoto?.id, onPhotoSelect, onOpenLightbox]);

  // Track container size (ResizeObserver also catches non-window resizes)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateDimensions = () => {
      setDimensions({ width: el.offsetWidth, height: el.offsetHeight });
    };
    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Build ID->index map for O(1) lookups
  const photoIndexMap = useMemo(() => {
    const indexMap = new Map();
    photos.forEach((photo, index) => {
      indexMap.set(photo.id, index);
    });
    return indexMap;
  }, [photos]);

  // Track visible items and request priority thumbnail generation
  const requestPriorityThumbnails = useMemo(
    () => debounce(async (startRow, stopRow) => {
      // Calculate visible photo indices from visible rows
      const startIndex = startRow * columns;
      const stopIndex = Math.min((stopRow + 1) * columns, photos.length);
      
      const visiblePhotos = photos.slice(startIndex, stopIndex);
      const filenames = visiblePhotos
        .filter(p => p.hasMediaFile && !p.isVideo)
        .map(p => p.filename);
      
      if (filenames.length === 0) return;
      
      try {
        await fetch(`${API_URL}/api/thumbnails/priority`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames })
        });
      } catch (error) {
        // Silent fail - thumbnails will still be generated eventually
      }
    }, 100), // Debounce 100ms for fast response
    [photos, columns]
  );

  // Handle visible items change from react-window
  const handleItemsRendered = useCallback(({ visibleRowStartIndex, visibleRowStopIndex }) => {
    requestPriorityThumbnails(visibleRowStartIndex, visibleRowStopIndex);
  }, [requestPriorityThumbnails]);

  // Scroll to selected photo
  useEffect(() => {
    if (gridRef.current && selectedPhoto) {
      const index = photoIndexMap.get(selectedPhoto.id);
      if (index !== undefined && index >= 0) {
        const row = Math.floor(index / columns);
        gridRef.current.scrollToItem({ rowIndex: row, align: 'smart' });
      }
    }
  }, [selectedPhoto, photoIndexMap, columns]);

  return (
    <div className="grid-view">
      <div className="grid-header">
        <h2>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
          Photo Gallery
        </h2>
        <span className="photo-count">{photos.length} items</span>
      </div>
      
      <div className="grid-content" ref={containerRef}>
        {dimensions.width > 0 && (
          <Grid
            ref={gridRef}
            columnCount={columns}
            columnWidth={ITEM_WIDTH}
            height={dimensions.height}
            rowCount={rows}
            rowHeight={ITEM_HEIGHT}
            width={dimensions.width}
            itemData={itemData}
            overscanRowCount={4}
            onItemsRendered={handleItemsRendered}
            className="grid-virtual"
          >
            {GridCell}
          </Grid>
        )}
      </div>
    </div>
  );
}

export default memo(GridView);
