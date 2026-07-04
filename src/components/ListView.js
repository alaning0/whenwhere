import React, { useMemo, useCallback, memo, useRef, useEffect, useState } from 'react';
import { VariableSizeList as List } from 'react-window';
import { format } from 'date-fns';
import './ListView.css';

// Fixed row heights so the list can be virtualized (CSS pins .list-item to 76px)
const PHOTO_ROW_HEIGHT = 86;        // 76px item + 10px gap
const HEADER_ROW_HEIGHT = 72;       // 28px group gap + 30px header + 14px gap
const FIRST_HEADER_ROW_HEIGHT = 44; // no group gap above the first header

// Memoized list item
const ListItem = memo(function ListItem({ photo, isSelected, onSelect, onOpenLightbox }) {
  const handleClick = useCallback(() => {
    onSelect(photo);
    onOpenLightbox();
  }, [photo, onSelect, onOpenLightbox]);

  return (
    <div
      className={`list-item ${isSelected ? 'selected' : ''} ${photo.isVideo ? 'is-video' : ''}`}
      onClick={handleClick}
    >
      <div className="list-item-thumb">
        {photo.hasMediaFile && photo.thumbnail && !photo.isVideo ? (
          <img src={photo.thumbnail} alt={photo.title} loading="lazy" />
        ) : (
          <div className="thumb-placeholder">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {photo.isVideo ?
                <polygon points="5 3 19 12 5 21 5 3"></polygon> :
                <><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle></>
              }
            </svg>
          </div>
        )}
      </div>

      <div className="list-item-info">
        <h4>{photo.title}</h4>
        <div className="list-item-meta">
          <span className="meta-date">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            {format(new Date(photo.date), 'MMM d, yyyy • h:mm a')}
          </span>
          <span className={`meta-location ${photo.hasLocation ? 'has-location' : ''}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
            {photo.location}
          </span>
        </div>
        <div className="list-item-badges">
          {photo.isVideo && <span className="badge video">Video</span>}
          {!photo.hasMediaFile && <span className="badge xmp-only">XMP Only</span>}
          {photo.hasLocation && <span className="badge gps">GPS</span>}
        </div>
      </div>

      <div className="list-item-actions">
        {photo.hasLocation && (
          <button className="action-btn" title="Has GPS location">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
              <line x1="8" y1="2" x2="8" y2="18"></line>
              <line x1="16" y1="6" x2="16" y2="22"></line>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
});

// Virtualized row: either a month header or a photo item
const ListRow = memo(function ListRow({ index, style, data }) {
  const { rows, selectedId, onSelect, onOpenLightbox } = data;
  const row = rows[index];

  if (row.type === 'header') {
    return (
      <div style={style} className="list-row list-row-header">
        <div className="group-header">
          <h3>{row.label}</h3>
          <span className="group-count">{row.count}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={style} className="list-row">
      <ListItem
        photo={row.photo}
        isSelected={selectedId === row.photo.id}
        onSelect={onSelect}
        onOpenLightbox={onOpenLightbox}
      />
    </div>
  );
});

function ListView({ photos, selectedPhoto, onPhotoSelect, onOpenLightbox }) {
  const containerRef = useRef(null);
  const listRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Photos arrive date-sorted from the server/cache. Flatten the month groups
  // into a single row array so the whole list can be windowed.
  const rows = useMemo(() => {
    const out = [];
    let currentHeader = null;
    for (const photo of photos) {
      const month = format(new Date(photo.date), 'MMMM yyyy');
      if (!currentHeader || currentHeader.label !== month) {
        currentHeader = { type: 'header', label: month, count: 0 };
        out.push(currentHeader);
      }
      currentHeader.count++;
      out.push({ type: 'photo', photo });
    }
    return out;
  }, [photos]);

  // Row heights changed positions when the data changes — clear the size cache
  useEffect(() => {
    listRef.current?.resetAfterIndex(0);
  }, [rows]);

  // Track container size (react-window needs pixel dimensions)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setDimensions({ width: el.offsetWidth, height: el.offsetHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const getItemSize = useCallback((index) => {
    if (rows[index].type === 'header') {
      return index === 0 ? FIRST_HEADER_ROW_HEIGHT : HEADER_ROW_HEIGHT;
    }
    return PHOTO_ROW_HEIGHT;
  }, [rows]);

  const getItemKey = useCallback((index, data) => {
    const row = data.rows[index];
    return row.type === 'header' ? `h:${row.label}` : row.photo.id;
  }, []);

  // Stable callback
  const handleSelect = useCallback((photo) => {
    onPhotoSelect(photo);
  }, [onPhotoSelect]);

  const itemData = useMemo(() => ({
    rows,
    selectedId: selectedPhoto?.id,
    onSelect: handleSelect,
    onOpenLightbox
  }), [rows, selectedPhoto?.id, handleSelect, onOpenLightbox]);

  return (
    <div className="list-view">
      <div className="list-header">
        <h2>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
          Photo Library
        </h2>
        <span className="photo-count">{photos.length} items</span>
      </div>

      <div className="list-content" ref={containerRef}>
        {dimensions.height > 0 && (
          <List
            ref={listRef}
            height={dimensions.height}
            width={dimensions.width}
            itemCount={rows.length}
            itemSize={getItemSize}
            itemData={itemData}
            itemKey={getItemKey}
            overscanCount={6}
            className="list-virtual"
          >
            {ListRow}
          </List>
        )}
      </div>
    </div>
  );
}

export default memo(ListView);
