import React, { useState, useEffect } from 'react';
import { API_URL } from '../config';
import './ScanProgress.css';

const phaseLabels = {
  idle: 'Connecting to server...',
  starting: 'Initializing scan...',
  scanning: 'Scanning directories...',
  collecting: 'Collecting files...',
  processing: 'Reading photo metadata...',
  sorting: 'Organizing photos...',
  complete: 'Ready!'
};

function ScanProgress({ onReady, onChooseDifferentFolder, imagesDir }) {
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: 'idle', scanning: false });
  const [connected, setConnected] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource(`${API_URL}/api/scan/progress`);

    eventSource.onopen = () => {
      setConnected(true);
      // Signal that we're ready to start fetching - SSE is connected
      if (onReady) {
        // Small delay to ensure listener is registered on server
        setTimeout(() => onReady(), 100);
      }
    };

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setProgress(data);
    };

    eventSource.onerror = () => {
      setConnected(false);
      // If SSE fails, still allow loading to proceed
      if (onReady) onReady();
    };

    return () => {
      eventSource.close();
    };
  }, [onReady]);

  const percentage = progress.total > 0 
    ? Math.round((progress.current / progress.total) * 100) 
    : 0;

  const scanActive = progress.scanning || !['idle', 'complete'].includes(progress.phase);

  const handleChooseDifferentFolder = async () => {
    if (!onChooseDifferentFolder || cancelling) return;
    setCancelling(true);
    try {
      await onChooseDifferentFolder();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="scan-progress">
      <div className="scan-progress-content">
        <div className="scan-progress-icon">
          {progress.phase === 'complete' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          ) : (
            <div className="scan-spinner"></div>
          )}
        </div>
        
        <div className="scan-progress-info">
          <div className="scan-progress-label">
            {phaseLabels[progress.phase] || 'Loading...'}
          </div>
          
          {/* Show stats for different phases */}
          <div className="scan-progress-stats">
            {progress.phase === 'idle' && 'Waiting for connection...'}
            {progress.phase === 'starting' && 'Preparing to scan files...'}
            {progress.phase === 'scanning' && (
              progress.current > 0 ? (
                <>
                  {progress.current.toLocaleString()} files found
                  {progress.total > 0 && ` · ${progress.total.toLocaleString()} folders`}
                </>
              ) : (
                'Looking for files...'
              )
            )}
            {progress.phase === 'processing' && progress.total > 0 && (
              <>
                {progress.current.toLocaleString()} / {progress.total.toLocaleString()} files
                <span className="scan-progress-percentage"> ({percentage}%)</span>
              </>
            )}
            {progress.phase === 'complete' && `${progress.total.toLocaleString()} photos loaded`}
          </div>
          
          {/* Progress bar: indeterminate for idle/starting/scanning, determinate for processing */}
          <div className="scan-progress-bar-container">
            <div 
              className={`scan-progress-bar ${['idle', 'starting', 'scanning'].includes(progress.phase) ? 'indeterminate' : ''}`}
              style={{ width: ['idle', 'starting', 'scanning'].includes(progress.phase) ? '100%' : `${percentage}%` }}
            />
          </div>
        </div>
      </div>

      {imagesDir && (
        <div className="scan-progress-folder" title={imagesDir}>
          {imagesDir}
        </div>
      )}

      {scanActive && onChooseDifferentFolder && (
        <div className="scan-progress-actions">
          <button
            type="button"
            className="scan-progress-cancel"
            onClick={handleChooseDifferentFolder}
            disabled={cancelling}
          >
            {cancelling ? 'Cancelling…' : 'Choose different folder'}
          </button>
        </div>
      )}
      
      {!connected && (
        <div className="scan-progress-disconnected">
          Connecting to server...
        </div>
      )}
    </div>
  );
}

export default ScanProgress;
