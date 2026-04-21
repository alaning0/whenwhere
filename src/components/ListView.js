import React, { useMemo, useCallback, memo } from 'react';
import { format } from 'date-fns';
import './ListView.css';

// Memoized list item
const ListItem = memo(function ListItem({ photo, isSelected, index, onSelect, onOpenLightbox }) {
  const handleClick = useCallback(() => {
    onSelect(photo);
    onOpenLightbox();
  }, [photo, onSelect, onOpenLightbox]);
  
  return (
    <div
      className={`list-item ${isSelected ? 'selected' : ''} ${photo.isVideo ? 'is-video' : ''}`}
      onClick={handleClick}
      style={{ animationDelay: `${Math.min(index * 0.03, 0.3)}s` }}
    >
      <div className="list-item-thumb">
        {photo.hasMediaFile && photo.url && !photo.isVideo ? (
          <img src={photo.url} alt={photo.title} loading="lazy" />
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

function ListView({ photos, selectedPhoto, onPhotoSelect, onOpenLightbox }) {
  // Memoize sorted photos
  const sortedPhotos = useMemo(
    () => [...photos].sort((a, b) => new Date(a.date) - new Date(b.date)),
    [photos]
  );

  // Memoize grouped photos
  const groupedPhotos = useMemo(() => {
    return sortedPhotos.reduce((acc, photo) => {
      const date = new Date(photo.date);
      const yearMonth = format(date, 'MMMM yyyy');
      if (!acc[yearMonth]) {
        acc[yearMonth] = [];
      }
      acc[yearMonth].push(photo);
      return acc;
    }, {});
  }, [sortedPhotos]);

  // Stable callback
  const handleSelect = useCallback((photo) => {
    onPhotoSelect(photo);
  }, [onPhotoSelect]);

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
      
      <div className="list-content">
        {Object.entries(groupedPhotos).map(([yearMonth, monthPhotos]) => (
          <div key={yearMonth} className="list-group">
            <div className="group-header">
              <h3>{yearMonth}</h3>
              <span className="group-count">{monthPhotos.length}</span>
            </div>
            
            <div className="photo-list">
              {monthPhotos.map((photo, index) => (
                <ListItem
                  key={photo.id}
                  photo={photo}
                  isSelected={selectedPhoto?.id === photo.id}
                  index={index}
                  onSelect={handleSelect}
                  onOpenLightbox={onOpenLightbox}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(ListView);
