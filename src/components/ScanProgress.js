import React, { useState, useEffect } from 'react';
import './ScanProgress.css';

const API_URL = 'http://localhost:3002';

const phaseLabels = {
  idle: 'Connecting to server...',
  starting: 'Initializing scan...',
  scanning: 'Scanning directories...',
  collecting: 'Collecting files...',
  processing: 'Reading photo metadata...',
  sorting: 'Organizing photos...',
  complete: 'Ready!'
};

function ScanProgress({ onComplete, onReady }) {
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: 'idle', scanning: false });
  const [connected, setConnected] = useState(false);

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
      
      // Notify parent when complete
      if (data.phase === 'complete' && onComplete) {
        onComplete();
      }
    };
    
    eventSource.onerror = () => {
      setConnected(false);
      // If SSE fails, still allow loading to proceed
      if (onReady) onReady();
    };
    
    return () => {
      eventSource.close();
    };
  }, [onComplete, onReady]);

  const percentage = progress.total > 0 
    ? Math.round((progress.current / progress.total) * 100) 
    : 0;

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
      
      {!connected && (
        <div className="scan-progress-disconnected">
          Connecting to server...
        </div>
      )}
    </div>
  );
}

export default ScanProgress;
