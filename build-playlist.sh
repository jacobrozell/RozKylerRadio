#!/usr/bin/env bash
# Build playlist.json from Renders/ (default: MP3 only for GitHub Pages).
# Usage: ./build-playlist.sh [--extensions .mp3 [.wav ...]]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$ROOT/scripts/build-playlist.py" "$@"
