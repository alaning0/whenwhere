# Contributing

## Development

Requires **Node.js 24+** (Active LTS) and npm.

```bash
cd server && npm install && cd ..
npm install
npm start              # browser: API + React
npm run electron:dev   # desktop shell
```

See the [README](README.md) for architecture, adapters, and configuration.

## Local Windows installer

To build the NSIS installer on your machine:

```bash
npm run dist:win
```

Output: `release/WhenWhere Setup <version>.exe`

This is useful for testing packaging changes. It does **not** publish a GitHub Release.

## Releasing

GitHub Releases are created by **pushing a version tag**. The workflow builds the installer and attaches it to the release.

### Steps

1. Bump `"version"` in `package.json` (and `server/package.json` if you keep them in sync).
2. Commit the version bump on `master`.
3. Tag and push (tag must match `v*`, and should match the package version):

```bash
git tag -a v1.0.1 -m "WhenWhere 1.0.1"
git push origin v1.0.1
```

4. Wait for **Build Windows installer** to finish on the tag.
5. Confirm the release at [Releases](https://github.com/alaning0/whenwhere/releases) — it should include `WhenWhere Setup <version>.exe`.

### What each trigger does

| Trigger | Result |
|---------|--------|
| Push tag `v*` (e.g. `v1.0.1`) | Build installer → upload Actions artifact → **create/update GitHub Release** with the `.exe` |
| Actions → **Run workflow** (manual) | Build installer → upload Actions artifact only (**no** Release) |

Manual runs are for smoke-testing the build. Ship to users via a tag.

### Notes

- electron-builder is configured with `--publish never`; publishing is handled by the workflow (`softprops/action-gh-release`), not by electron-builder.
- The workflow needs `contents: write` so the default `GITHUB_TOKEN` can create releases.
- Prefer linking users to [GitHub Releases](https://github.com/alaning0/whenwhere/releases) rather than committing large `.exe` files to the repo.
