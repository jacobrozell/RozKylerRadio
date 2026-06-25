# RozKylerRadio

Shuffle radio for the **RozKyler Archives** — a static web player over your consolidated `Renders/` pool. Hosted on GitHub Pages; no build step for the UI itself.

**Status:** Live on GitHub Pages · static site · no app versioning

---
## Live site

Push to `main` deploys via GitHub Actions (see `.github/workflows/pages.yml`). Enable **Pages → Build: GitHub Actions** once in repo settings.

## Local preview

`file://` will not load `playlist.json`. From the repo root:

```bash
npx serve
```

Open the URL it prints (usually `http://localhost:3000`).

## Playlist

`playlist.json` is generated from audio under `Renders/`. For GitHub Pages, ship **MP3 only** (WAV/FLAC stay local — see `Renders/_SHIPPING.txt`).

```bash
./build-playlist.sh
# or: python3 scripts/build-playlist.py --extensions .mp3
```

Validate before deploy:

```bash
python3 scripts/validate-playlist.py
```

Windows: use `build-playlist.ps1` with the same flags (`-Extensions .mp3`).

## Optional likes → Discord

Anonymous heart button posts to a Cloudflare Worker. Setup: `like-discord-setup.txt`.

## Config

Edit `config.js`:

| Key | Purpose |
|-----|---------|
| `basePath` | Prefix for `playlist.json` if not at site root |
| `mediaBase` | Prefix for audio paths when files live elsewhere on the host |
| `likeEndpoint` / `likeSecret` | Worker URL and weak shared secret |
| `debug` | `true` shows raw file URLs under Now playing |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Play / pause |
| ← / → | Previous / next in shuffle |
| `/` | Focus track search |
| Shuffle button | New random rotation order |

## Repo layout

| Path | Role |
|------|------|
| `index.html`, `app.js`, `styles.css` | Player UI |
| `playlist.json` | Generated catalog |
| `Renders/` | MP3 files (lossless gitignored) |
| `scripts/` | Playlist build + validation |
| `like-worker-cloudflare.js` | Optional Worker |
