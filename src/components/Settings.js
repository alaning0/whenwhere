import React, { useState, useEffect, useCallback } from 'react';
import { API_URL } from '../config';
import './Settings.css';

const ADAPTER_LABELS = {
  exif: 'EXIF (embedded metadata)',
  xmp: 'XMP sidecars',
  'google-takeout': 'Google Photos Takeout',
};

function FolderBrowseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
    </svg>
  );
}

function Settings({ open, onClose, onSaved, required = false }) {
  const [adapter, setAdapter] = useState('exif');
  const [imagesDir, setImagesDir] = useState('');
  const [thumbnailsDir, setThumbnailsDir] = useState('');
  const [adapters, setAdapters] = useState(['exif', 'xmp', 'google-takeout']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const canBrowse = Boolean(window.whenwhere?.selectFolder);

  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`${API_URL}/api/config`);
      if (!response.ok) {
        throw new Error('Failed to load settings');
      }
      const data = await response.json();
      setAdapter(data.adapter || 'exif');
      setImagesDir(data.imagesDir || '');
      setThumbnailsDir(data.thumbnailsDir || '');
      if (Array.isArray(data.adapters) && data.adapters.length > 0) {
        setAdapters(data.adapters);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConfig();
    }
  }, [open, loadConfig]);

  const browseFolder = async (field) => {
    if (!window.whenwhere?.selectFolder) return;
    try {
      const selected = await window.whenwhere.selectFolder(
        field === 'images' ? 'Select photos folder' : 'Select thumbnails folder'
      );
      if (!selected) return;
      if (field === 'images') {
        setImagesDir(selected);
        if (!thumbnailsDir) {
          setThumbnailsDir(`${selected}${selected.includes('\\') ? '\\' : '/'}.thumbnails`);
        }
      } else {
        setThumbnailsDir(selected);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!imagesDir.trim()) {
      setError('Photos folder is required');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const response = await fetch(`${API_URL}/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          adapter,
          imagesDir: imagesDir.trim(),
          thumbnailsDir: thumbnailsDir.trim(),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to save settings');
      }

      onSaved?.(data);
      if (!required) {
        onClose?.();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div className="settings-modal">
        <div className="settings-header">
          <h2 id="settings-title">{required ? 'Welcome to WhenWhere' : 'Settings'}</h2>
          {!required && (
            <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          )}
        </div>

        {required && (
          <p className="settings-intro">
            Choose the folder that contains your photos to get started.
          </p>
        )}

        {loading ? (
          <div className="settings-loading">Loading settings…</div>
        ) : (
          <form className="settings-form" onSubmit={handleSave}>
            <label className="settings-field">
              <span className="settings-label">Photos folder</span>
              <div className="settings-path-row">
                <input
                  type="text"
                  value={imagesDir}
                  onChange={(e) => setImagesDir(e.target.value)}
                  placeholder="C:\Photos"
                  required
                  autoFocus={required}
                />
                {canBrowse && (
                  <button
                    type="button"
                    className="settings-browse"
                    onClick={() => browseFolder('images')}
                    aria-label="Browse for photos folder"
                    title="Browse for photos folder"
                  >
                    <FolderBrowseIcon />
                  </button>
                )}
              </div>
            </label>

            <label className="settings-field">
              <span className="settings-label">Thumbnails folder</span>
              <div className="settings-path-row">
                <input
                  type="text"
                  value={thumbnailsDir}
                  onChange={(e) => setThumbnailsDir(e.target.value)}
                  placeholder="Defaults to photos folder\.thumbnails"
                />
                {canBrowse && (
                  <button
                    type="button"
                    className="settings-browse"
                    onClick={() => browseFolder('thumbnails')}
                    aria-label="Browse for thumbnails folder"
                    title="Browse for thumbnails folder"
                  >
                    <FolderBrowseIcon />
                  </button>
                )}
              </div>
              <span className="settings-hint">Leave blank to use a .thumbnails folder inside your photos directory.</span>
            </label>

            <label className="settings-field">
              <span className="settings-label">Metadata adapter</span>
              <select value={adapter} onChange={(e) => setAdapter(e.target.value)}>
                {adapters.map((name) => (
                  <option key={name} value={name}>
                    {ADAPTER_LABELS[name] || name}
                  </option>
                ))}
              </select>
            </label>

            {error && <div className="settings-error">{error}</div>}

            <div className="settings-actions">
              {!required && (
                <button type="button" className="settings-btn secondary" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
              )}
              <button type="submit" className="settings-btn primary" disabled={saving}>
                {saving ? 'Saving…' : required ? 'Get started' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default Settings;
