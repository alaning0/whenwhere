# WhenWhere — Windows release

Pre-built installer for WhenWhere. No Node.js or developer tools required.

**Preferred download:** the latest build on [GitHub Releases](https://github.com/alaning0/whenwhere/releases). Maintainers publish those by pushing a `v*` tag — see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Download (this folder)

| File | Description |
|------|-------------|
| [WhenWhere Setup 1.0.0.exe](./WhenWhere%20Setup%201.0.0.exe) | Windows x64 installer (NSIS) |

> **Git clone note:** this `.exe` is stored with [Git LFS](https://git-lfs.com). If the file is only a few hundred bytes after cloning, run `git lfs pull` (or install Git LFS and re-clone). On GitHub, use the **Download** button on the file page to get the real binary.

## Install

1. Double-click **WhenWhere Setup 1.0.0.exe**
2. Choose an install location (or accept the default)
3. Finish the wizard — shortcuts are added to the Start Menu and desktop

To remove the app later, use **Apps & features** in Windows Settings, or the uninstaller from the install folder.

## First launch

1. Open **WhenWhere**
2. Settings opens automatically if no photos folder is configured
3. Set:
   - **Photos folder** — directory that contains your images/videos
   - **Thumbnails folder** — optional; defaults to `<photos>\.thumbnails`
   - **Metadata adapter** — how dates and GPS are read (see below)
4. Click **Get started** / **Save**

You can change these anytime via the gear icon in the header.

Settings are stored at:

```
%APPDATA%\whenwhere\config.json
```

## Metadata adapters

| Adapter | Use when |
|---------|----------|
| **EXIF** | Normal camera/phone exports, iCloud Photos exports |
| **XMP** | Exports with `.xmp` sidecars (e.g. osxphotos `--sidecar xmp`) |
| **Google Photos Takeout** | Unpacked Google Takeout folders with JSON metadata |

## Supported media

- **Images:** JPEG, PNG, GIF, WebP, HEIC
- **Videos:** MOV, MP4, M4V

Photos with GPS show on the map; all dated media appear on the timeline, list, and grid views.

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Installer is tiny / won't run | Install [Git LFS](https://git-lfs.com) and run `git lfs pull`, or download the `.exe` from GitHub in the browser |
| App shows a blank error or won't start | Fully quit WhenWhere, then start it again. Ensure nothing else is using port **3002** |
| No photos appear | Confirm the photos folder path in Settings and that the adapter matches your export type |
| Reset settings | Delete `%APPDATA%\whenwhere\config.json` and restart the app |

## Building this installer

Local build (requires Node.js 24+):

```bash
npm install
cd server && npm install && cd ..
npm run dist:win
```

Output:

- `release/WhenWhere Setup <version>.exe` — installer
- `release/win-unpacked/` — local unpacked build (not committed)

To publish a GitHub Release (tag push → CI), see [CONTRIBUTING.md](../CONTRIBUTING.md). Development setup is in the [main README](../README.md).
