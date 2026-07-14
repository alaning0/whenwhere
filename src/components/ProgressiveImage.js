import React, { useState, useEffect, memo } from 'react';
import './ProgressiveImage.css';

/**
 * Shows the (usually already-cached) thumbnail instantly, then swaps to the
 * full-resolution image once it has finished downloading. The thumbnail is
 * lightly blurred so the upscaled placeholder reads as intentional and the
 * swap looks like a sharpen rather than a pop-in.
 *
 * Key this by photo id at the call site so it resets per photo.
 */
const ProgressiveImage = memo(function ProgressiveImage({ thumbnail, full, alt, className = '' }) {
  const [showFull, setShowFull] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    const done = () => { if (!cancelled) setShowFull(true); };
    img.onload = done;
    img.src = full;
    // Already in the browser cache (e.g. preloaded neighbor) — swap immediately
    if (img.complete) done();
    return () => { cancelled = true; img.onload = null; };
  }, [full]);

  const src = (showFull || !thumbnail) ? full : thumbnail;

  return (
    <img
      src={src}
      alt={alt}
      draggable="false"
      className={`progressive-img ${showFull ? 'is-full' : 'is-thumb'} ${className}`.trim()}
    />
  );
});

export default ProgressiveImage;
