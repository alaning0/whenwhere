import React, { useState, useEffect, useRef, useCallback } from 'react';
import './StatusPopover.css';

const API_URL = 'http://localhost:3002';

function StatusPopover() {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const popoverRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/api/thumbnails/status`);
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      }
    } catch (error) {
      console.error('Failed to fetch status:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Handle polling when open or background task is in progress
  useEffect(() => {
    let intervalId;
    
    // Poll more frequently when open, less frequently when closed but processing
    const shouldPoll = isOpen || (status?.inProgress);
    const intervalTime = isOpen ? 3000 : 10000;

    if (shouldPoll) {
      intervalId = setInterval(() => {
        fetchStatus();
      }, intervalTime);
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [isOpen, status?.inProgress, fetchStatus]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  const togglePopover = () => {
    setIsOpen(!isOpen);
  };

  return (
    <div className="status-popover-container" ref={popoverRef}>
      <button 
        className={`status-trigger ${isOpen ? 'active' : ''} ${status?.inProgress ? 'processing' : ''}`}
        onClick={togglePopover}
        title="Server Status"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        {status?.inProgress && (
          <span className="processing-indicator"></span>
        )}
      </button>

      {isOpen && (
        <div className="status-popover">
          <div className="popover-header">
            <h3>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                <line x1="6" y1="6" x2="6.01" y2="6"></line>
                <line x1="6" y1="18" x2="6.01" y2="18"></line>
              </svg>
              Server Status
            </h3>
            <button className="refresh-btn" onClick={fetchStatus} disabled={loading}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={loading ? 'spinning' : ''}>
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
          </div>

          {status ? (
            <div className="popover-content">
              {/* Thumbnail Progress */}
              <div className="status-section">
                <div className="section-header">
                  <span className="section-title">Thumbnail Generation</span>
                  {status.inProgress && (
                    <span className="status-badge processing">Processing</span>
                  )}
                  {!status.inProgress && status.percentage === 100 && (
                    <span className="status-badge complete">Complete</span>
                  )}
                </div>
                
                <div className="progress-bar-container">
                  <div 
                    className="progress-bar" 
                    style={{ width: `${status.percentage}%` }}
                  ></div>
                </div>
                
                <div className="progress-stats">
                  <span>{status.generated} / {status.totalImages}</span>
                  <span className="percentage">{status.percentage}%</span>
                </div>
              </div>

              {/* Photo Stats */}
              <div className="status-section">
                <div className="section-title">Photo Statistics</div>
                <div className="stats-grid">
                  <div className="stat-item">
                    <span className="stat-value">{status.totalPhotos}</span>
                    <span className="stat-label">Total XMP Files</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-value">{status.totalImages}</span>
                    <span className="stat-label">Image Files</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-value">{status.withLocation}</span>
                    <span className="stat-label">With GPS</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-value">{status.withMedia}</span>
                    <span className="stat-label">With Media</span>
                  </div>
                </div>
              </div>

              {/* Directories */}
              <div className="status-section">
                <div className="section-title">Directories</div>
                <div className="directory-item">
                  <span className="dir-label">Images:</span>
                  <span className="dir-path" title={status.imagesDirectory}>
                    {status.imagesDirectory}
                  </span>
                </div>
                <div className="directory-item">
                  <span className="dir-label">Thumbnails:</span>
                  <span className="dir-path" title={status.thumbnailsDirectory}>
                    {status.thumbnailsDirectory}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="popover-loading">
              <div className="loading-spinner-small"></div>
              <span>Loading status...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default StatusPopover;
