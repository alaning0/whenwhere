import React, { useEffect, useCallback, memo } from 'react';
import './Lightbox.css';

function Lightbox({ photo, photos, onClose, onNavigate }) {
  // Find current index
  const currentIndex = photos.findIndex(p => p.id === photo?.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < photos.length - 1;

  const handlePrev = useCallback(() => {
    if (hasPrev) {
      onNavigate(photos[currentIndex - 1]);
    }
  }, [hasPrev, currentIndex, photos, onNavigate]);

  const handleNext = useCallback(() => {
    if (hasNext) {
      onNavigate(photos[currentIndex + 1]);
    }
  }, [hasNext, currentIndex, photos, onNavigate]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          handlePrev();
          break;
        case 'ArrowRight':
          handleNext();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, handlePrev, handleNext]);

  // Prevent body scroll when lightbox is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  if (!photo) return null;

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div className="lightbox-content" onClick={e => e.stopPropagation()}>
        {/* Close button */}
        <button className="lightbox-close" onClick={onClose} title="Close (Esc)">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        {/* Navigation buttons */}
        <button 
          className={`lightbox-nav prev ${!hasPrev ? 'disabled' : ''}`}
          onClick={handlePrev}
          disabled={!hasPrev}
          title="Previous (←)"
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>

        <button 
          className={`lightbox-nav next ${!hasNext ? 'disabled' : ''}`}
          onClick={handleNext}
          disabled={!hasNext}
          title="Next (→)"
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>

        {/* Main image area */}
        <div className="lightbox-image-container">
          {photo.hasMediaFile && photo.url ? (
            photo.isVideo ? (
              <video 
                src={photo.url} 
                controls 
                autoPlay
                className="lightbox-video"
              />
            ) : (
              <img src={photo.url} alt={photo.title} className="lightbox-image" />
            )
          ) : (
            <div className="lightbox-no-media">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                <circle cx="8.5" cy="8.5" r="1.5"></circle>
                <polyline points="21 15 16 10 5 21"></polyline>
              </svg>
              <p>No media file available</p>
              <p className="hint">XMP metadata only</p>
            </div>
          )}
        </div>

        {/* Photo info bar */}
        <div className="lightbox-info">
          <div className="lightbox-info-left">
            <h2>{photo.title}</h2>
            <div className="lightbox-meta">
              <span className="meta-date">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                {photo.dateFormatted}
              </span>
              {photo.hasLocation && (
                <span className="meta-location">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                    <circle cx="12" cy="10" r="3"></circle>
                  </svg>
                  {photo.location}
                </span>
              )}
            </div>
          </div>
          <div className="lightbox-info-right">
            <span className="photo-counter">{currentIndex + 1} / {photos.length}</span>
            <div className="lightbox-badges">
              {photo.isVideo && <span className="badge video">Video</span>}
              {photo.hasLocation && <span className="badge gps">GPS</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(Lightbox);

