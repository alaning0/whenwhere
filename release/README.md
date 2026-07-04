# WhenWhere — Windows install guide

Installers are published on [GitHub Releases](https://github.com/alaning0/whenwhere/releases) — no Node.js or developer tools required. Maintainers publish them by pushing a `v*` tag — see [CONTRIBUTING.md](../CONTRIBUTING.md). Installers are **not** committed to this folder; locally built ones land here but stay untracked.

After the first install, the app checks for updates automatically and can install them in-app (**Help → Check for Updates…**) — no need to download a new installer by hand.

## Install

1. Download the latest `WhenWhere-Setup-<version>.exe` from [GitHub Releases](https://github.com/alaning0/whenwhere/releases)
2. Double-click the installer and choose an install location (or accept the default)
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

- `release/WhenWhere-Setup-<version>.exe` — installer
- `release/win-unpacked/` — local unpacked build

Everything in this folder except this README is untracked build output.

To publish a GitHub Release (tag push → CI), see [CONTRIBUTING.md](../CONTRIBUTING.md). Development setup is in the [main README](../README.md).
