# WhenWhere

Visualize your photos on interactive maps and timelines using GPS metadata from EXIF, XMP sidecars, or Google Photos Takeout exports.

<img width="1424" height="843" alt="image" src="screenshot.png" />

## Features

- **Map View**: Interactive Leaflet map with photo markers, clustering, and multiple tile layers
- **Timeline**: Horizontal scrollable timeline sorted by date with virtualized rendering
- **List View**: Photos grouped by month with metadata details
- **Grid View**: Photo gallery grid grouped by date with lazy loading
- **Lightbox**: Full-screen photo/video viewer with keyboard navigation
- **Calendar**: Jump to any date with photos

### Supported Formats

| Media | Extensions |
|-------|------------|
| Images | JPEG, PNG, GIF, WebP, HEIC |
| Videos | MOV, MP4, M4V |

### Metadata Sources

| Adapter | Source | Use Case |
|---------|--------|----------|
| `exif` | Embedded EXIF data | iCloud Photos exports, camera imports |
| `xmp` | XMP sidecar files | osxphotos exports with `--sidecar xmp` |
| `google-takeout` | JSON metadata files | Google Photos Takeout exports |

## Prerequisites

- Node.js 18+
- npm

## Quick Start

### 1. Clone and Install

```bash
# Install server dependencies
cd server
npm install

# Install frontend dependencies
cd ..
npm install
```

### 2. Configure

```bash
# Copy the example config
cp server/.env.example server/.env

# Edit with your paths
nano server/.env
```

Example `.env`:
```bash
ADAPTER=exif
IMAGES_DIR=/path/to/your/photos
THUMBNAILS_DIR=/path/to/thumbnails
PORT=3002
```

### 3. Run

```bash
# Start both server and frontend
npm start
```

- Frontend: http://localhost:3000
- API: http://localhost:3002

## Configuration

All configuration is done via environment variables in `server/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `ADAPTER` | `exif` | Metadata adapter: `exif`, `xmp`, or `google-takeout` |
| `IMAGES_DIR` | `./Content` | Directory containing your photos |
| `THUMBNAILS_DIR` | `./.thumbnails` | Where to store generated thumbnails |
| `PORT` | `3002` | Server port |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React)                            │
│                        localhost:3000                               │
├─────────────────────────────────────────────────────────────────────┤
│  App.js                                                             │
│  ├── MapView.js      (Leaflet map with clustered markers)          │
│  ├── Timeline.js     (Virtualized horizontal timeline)             │
│  ├── ListView.js     (Grouped list view by month)                  │
│  ├── GridView.js     (Photo grid gallery by date)                  │
│  └── Lightbox.js     (Fullscreen photo/video viewer)               │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ REST API
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        BACKEND (Express)                            │
│                        localhost:3002                               │
├─────────────────────────────────────────────────────────────────────┤
│  server/index.js                                                    │
│  ├── config.js           (Environment-based configuration)         │
│  └── adapters/                                                      │
│      ├── exifAdapter.js  (EXIF metadata from images)               │
│      ├── xmpAdapter.js   (XMP sidecar files)                       │
│      └── GooglePhotosTakeoutAdapter.js  (JSON metadata)            │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ File System
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       YOUR PHOTOS                                   │
├─────────────────────────────────────────────────────────────────────┤
│  IMAGES_DIR/                                                        │
│  ├── *.jpg, *.heic, *.png   (Images)                               │
│  ├── *.mov, *.mp4           (Videos)                                │
│  ├── *.xmp                  (XMP sidecars, if using xmp adapter)   │
│  └── *.json                 (Takeout metadata, if using google)    │
└─────────────────────────────────────────────────────────────────────┘
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/photos` | List all photos with metadata |
| GET | `/api/photos?withLocation=true` | Filter to photos with GPS data |
| GET | `/api/photos?withMedia=true` | Filter to photos with media files |
| GET | `/api/photos/:id` | Get single photo details |
| GET | `/images/:filename` | Serve media file |
| GET | `/images/:filename?thumb=true` | Serve thumbnail (WebP, 300px) |
| GET | `/api/thumbnails/status` | Thumbnail generation progress |
| POST | `/api/thumbnails/priority` | Prioritize thumbnail generation |
| GET | `/api/scan/progress` | SSE endpoint for scan progress |
| GET | `/api/adapter` | Get current adapter info |
| POST | `/api/refresh` | Force refresh the cache |
| GET | `/api/health` | Health check |

### Photo Object Schema

```typescript
interface Photo {
  id: number;              // Unique identifier
  filename: string;        // Media filename
  title: string;           // Display title
  url: string | null;      // Full media URL
  thumbnail: string | null; // Thumbnail URL
  date: string;            // ISO 8601 date
  dateFormatted: string;   // "January 1, 2024"
  dateShort: string;       // "Jan 1, '24"
  timeFormatted: string;   // "3:45 PM"
  timeShort: string;       // "15:45"
  lat: number | null;      // GPS latitude
  lng: number | null;      // GPS longitude
  hasLocation: boolean;    // Has GPS coordinates
  hasMediaFile: boolean;   // Has media file on disk
  isVideo: boolean;        // Is video file
  isImage: boolean;        // Is image file
  size: number;            // File size in bytes
  location: string;        // Formatted coordinates
}
```

## Creating Custom Adapters

To support a new metadata source, create an adapter in `server/adapters/`:

1. Copy `_template.js` as your starting point
2. Implement `scanPhotos(imagesDir, serverPort, onProgress)`
3. Implement `getAdapterInfo()`
4. Add your adapter to the map in `server/index.js`

See `server/adapters/_template.js` for full documentation.

## Performance

- **Virtualized lists**: Timeline and grid use windowing for smooth scrolling
- **Marker clustering**: Map clusters thousands of markers efficiently
- **Background thumbnails**: Generated asynchronously after initial scan
- **Priority queue**: Visible thumbnails generated first
- **IndexedDB cache**: Photos cached locally for instant reload
- **Lazy loading**: Images load on-demand

## File Structure

```
whenwhere/
├── public/
│   └── index.html
├── server/
│   ├── .env.example        # Configuration template
│   ├── config.js           # Configuration loader
│   ├── index.js            # Express server
│   ├── package.json
│   └── adapters/
│       ├── _template.js    # Adapter template
│       ├── utils.js        # Shared utilities
│       ├── exifAdapter.js
│       ├── xmpAdapter.js
│       └── GooglePhotosTakeoutAdapter.js
├── src/
│   ├── config.js           # Frontend config
│   ├── App.js
│   ├── App.css
│   ├── index.js
│   ├── index.css
│   ├── components/
│   │   ├── MapView.js / .css
│   │   ├── Timeline.js / .css
│   │   ├── ListView.js / .css
│   │   ├── GridView.js / .css
│   │   ├── Lightbox.js / .css
│   │   ├── CalendarOverlay.js / .css
│   │   ├── ScanProgress.js / .css
│   │   └── StatusPopover.js / .css
│   └── services/
│       └── photoCache.js   # IndexedDB cache
├── package.json
└── README.md
```

## Exporting Photos

### From Apple Photos (via osxphotos)

```bash
osxphotos export /path/to/export \
  --sidecar xmp \
  --download-missing \
  --verbose
```

Then set `ADAPTER=xmp` and `IMAGES_DIR=/path/to/export`.

### From Google Photos

1. Go to [Google Takeout](https://takeout.google.com)
2. Select only "Google Photos"
3. Download and extract

Then set `ADAPTER=google-takeout` and `IMAGES_DIR=/path/to/Google Photos`.

### From iCloud Photos

Use Apple's built-in export or a third-party tool. EXIF data is preserved in the images.

Then set `ADAPTER=exif` and `IMAGES_DIR=/path/to/photos`.

## Known Limitations

- HEIC images converted to JPEG on-the-fly (may be slow for very large files)
- Video EXIF extraction not yet supported
- Large libraries (10,000+ photos) may have slower initial scan
- No user preferences persistence (view state resets on refresh)

## License

MIT
