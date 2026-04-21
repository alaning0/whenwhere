import React, { useRef, useEffect, useMemo, useCallback, memo, useState } from 'react';
import { FixedSizeList as List } from 'react-window';
import CalendarOverlay from './CalendarOverlay';
import { API_URL } from '../config';
import './Timeline.css';

// Item width for virtualization
const ITEM_WIDTH = 90;

// Debounce helper
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

// Helper to get date key for comparison (YYYY-MM-DD)
function getDateKey(dateStr) {
  return dateStr ? dateStr.split('T')[0] : '';
}

// Virtualized timeline item renderer
const TimelineItemRenderer = memo(function TimelineItemRenderer({ index, style, data }) {
  const { photos, selectedId, onSelect, firstOfDayIndices } = data;
  const photo = photos[index];
  const isSelected = photo.id === selectedId;
  const isFirstOfDay = firstOfDayIndices.has(index);
  
  const handleClick = useCallback(() => {
    const sortDate = new Date(photo.date);
    console.log(`Selected photo: ${photo.filename}`);
    console.log(`  Raw date string: ${photo.date}`);
    console.log(`  Parsed for sorting: ${sortDate.toISOString()} (timestamp: ${sortDate.getTime()})`);
    console.log(`  Formatted display: ${photo.dateFormatted} ${photo.timeFormatted}`);
    onSelect(photo);
  }, [photo, onSelect]);
  
  return (
    <div
      style={style}
      data-id={photo.id}
      className={`timeline-item ${isSelected ? 'selected' : ''} ${photo.isVideo ? 'is-video' : ''} ${!photo.hasMediaFile ? 'no-media' : ''} ${isFirstOfDay ? 'first-of-day' : ''}`}
      onClick={handleClick}
    >
      {isFirstOfDay && (
        <div className="timeline-day-label">
          {photo.dateShort}
        </div>
      )}
      <div className="timeline-dot"></div>
      <div className="timeline-thumb">
        {photo.hasMediaFile && photo.thumbnail && !photo.isVideo ? (
          <>
            <div className="thumb-loading-skeleton"></div>
            <img 
              src={photo.thumbnail} 
              alt={photo.title} 
              draggable="false" 
              loading="lazy"
              onLoad={(e) => e.target.classList.add('loaded')}
            />
          </>
        ) : (
          <div className="thumb-placeholder">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {photo.isVideo ? 
                <polygon points="5 3 19 12 5 21 5 3"></polygon> :
                <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle></>
              }
            </svg>
          </div>
        )}
        <div className="timeline-overlay">
          <span className="timeline-date">
            {photo.dateShort}
          </span>
        </div>
      </div>
      <span className="timeline-year">
        {photo.timeShort}
      </span>
    </div>
  );
});

function Timeline({ photos, selectedPhoto, onPhotoSelect, pinMode, onPinModeChange }) {
  const listRef = useRef(null);
  const containerRef = useRef(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Photos are already sorted by date from server - no need to re-sort!
  // Build an ID->index map for O(1) lookups and track first-of-day indices
  const { photoIndexMap, sortedPhotos, firstOfDayIndices } = useMemo(() => {
    const indexMap = new Map();
    const dayIndices = new Set();
    let lastDateKey = '';
    
    photos.forEach((photo, index) => {
      indexMap.set(photo.id, index);
      
      // Check if this is the first photo of a new day
      const dateKey = getDateKey(photo.date);
      if (dateKey !== lastDateKey) {
        dayIndices.add(index);
        lastDateKey = dateKey;
      }
    });
    
    return { photoIndexMap: indexMap, sortedPhotos: photos, firstOfDayIndices: dayIndices };
  }, [photos]);
  
  // O(1) lookup for current index instead of O(n) findIndex
  const currentIndex = useMemo(
    () => selectedPhoto ? (photoIndexMap.get(selectedPhoto.id) ?? -1) : -1,
    [photoIndexMap, selectedPhoto]
  );

  // Track visible items and request priority thumbnail generation
  const requestPriorityThumbnails = useMemo(
    () => debounce(async (startIndex, stopIndex) => {
      // Get filenames of visible items that have media files
      const visiblePhotos = sortedPhotos.slice(startIndex, stopIndex + 1);
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
    [sortedPhotos]
  );

  // Handle visible items change from react-window
  const handleItemsRendered = useCallback(({ visibleStartIndex, visibleStopIndex }) => {
    requestPriorityThumbnails(visibleStartIndex, visibleStopIndex);
  }, [requestPriorityThumbnails]);

  // Item data for virtualized list
  const itemData = useMemo(() => ({
    photos: sortedPhotos,
    selectedId: selectedPhoto?.id,
    onSelect: onPhotoSelect,
    firstOfDayIndices
  }), [sortedPhotos, selectedPhoto?.id, onPhotoSelect, firstOfDayIndices]);

  // Scroll to selected photo
  useEffect(() => {
    if (listRef.current && currentIndex >= 0) {
      listRef.current.scrollToItem(currentIndex, 'center');
    }
  }, [currentIndex]);

  const handlePrev = useCallback(() => {
    if (currentIndex > 0) {
      onPhotoSelect(sortedPhotos[currentIndex - 1]);
    }
  }, [currentIndex, sortedPhotos, onPhotoSelect]);

  const handleNext = useCallback(() => {
    if (currentIndex < sortedPhotos.length - 1) {
      onPhotoSelect(sortedPhotos[currentIndex + 1]);
    }
  }, [currentIndex, sortedPhotos, onPhotoSelect]);

  const handleOpenCalendar = useCallback(() => {
    setCalendarOpen(true);
  }, []);

  const handleCloseCalendar = useCallback(() => {
    setCalendarOpen(false);
  }, []);

  // Get container width for the virtualized list
  const [containerWidth, setContainerWidth] = useState(800);
  
  useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };
    
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  // Scroll the timeline left/right
  const handleScrollLeft = useCallback(() => {
    if (listRef.current) {
      const currentScroll = listRef.current.state.scrollOffset;
      const scrollAmount = containerWidth * 0.8; // Scroll 80% of visible width
      listRef.current.scrollTo(Math.max(0, currentScroll - scrollAmount));
    }
  }, [containerWidth]);

  const handleScrollRight = useCallback(() => {
    if (listRef.current) {
      const currentScroll = listRef.current.state.scrollOffset;
      const scrollAmount = containerWidth * 0.8;
      const maxScroll = (sortedPhotos.length * ITEM_WIDTH) - containerWidth;
      listRef.current.scrollTo(Math.min(maxScroll, currentScroll + scrollAmount));
    }
  }, [containerWidth, sortedPhotos.length]);

  return (
    <div className="timeline-container">
      <div className="timeline-header">
        <div className="timeline-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          <span>Timeline</span>
          <button 
            className="calendar-btn" 
            onClick={handleOpenCalendar}
            title="Open calendar view"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
          </button>
          {selectedPhoto && (
            <span className="photo-counter">
              {currentIndex + 1} / {sortedPhotos.length}
            </span>
          )}
        </div>
        
        <div className="timeline-controls">
          <div className="pin-mode-selector">
            <span className="pin-mode-label">Pins:</span>
            <div className="pin-mode-options">
              <button 
                className={`pin-mode-btn ${pinMode === 'none' ? 'active' : ''}`}
                onClick={() => onPinModeChange('none')}
                title="Hide all pins"
              >
                None
              </button>
              <button 
                className={`pin-mode-btn ${pinMode === 'single' ? 'active' : ''}`}
                onClick={() => onPinModeChange('single')}
                title="Show only selected pin"
              >
                Single
              </button>
              <button 
                className={`pin-mode-btn ${pinMode === 'all' ? 'active' : ''}`}
                onClick={() => onPinModeChange('all')}
                title="Show all pins"
              >
                All
              </button>
            </div>
          </div>
          
          <button 
            className="nav-btn" 
            onClick={handlePrev}
            disabled={currentIndex <= 0}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
          
          <button 
            className="nav-btn" 
            onClick={handleNext}
            disabled={currentIndex >= sortedPhotos.length - 1}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="9 18 15 12 9 6"></polyline>
            </svg>
          </button>
        </div>
      </div>
      
      <div className="timeline-track-container" ref={containerRef}>
        <div className="timeline-line"></div>
        
        {/* Left scroll button */}
        <button className="timeline-scroll-btn left" onClick={handleScrollLeft} title="Scroll left">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        
        <List
          ref={listRef}
          height={130}
          width={containerWidth}
          itemCount={sortedPhotos.length}
          itemSize={ITEM_WIDTH}
          layout="horizontal"
          itemData={itemData}
          overscanCount={15}
          onItemsRendered={handleItemsRendered}
          className="timeline-virtual-list"
        >
          {TimelineItemRenderer}
        </List>
        
        {/* Right scroll button */}
        <button className="timeline-scroll-btn right" onClick={handleScrollRight} title="Scroll right">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      </div>
      
      {calendarOpen && (
        <CalendarOverlay
          photos={photos}
          onClose={handleCloseCalendar}
          onPhotoSelect={onPhotoSelect}
        />
      )}
    </div>
  );
}

export default memo(Timeline);
