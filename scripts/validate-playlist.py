#!/usr/bin/env python3
"""Ensure every playlist entry exists on disk and uses allowed extensions."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    playlist_path = repo_root / "playlist.json"
    allowed = {".mp3"}

    data = json.loads(playlist_path.read_text(encoding="utf-8"))
    tracks = data.get("tracks") or data
    if not isinstance(tracks, list):
        print("playlist.json: tracks must be an array", file=sys.stderr)
        return 1

    errors: list[str] = []
    for i, track in enumerate(tracks):
        src = track.get("src") if isinstance(track, dict) else track
        if not src:
            errors.append(f"[{i}] missing src")
            continue
        ext = Path(src).suffix.lower()
        if ext not in allowed:
            errors.append(f"[{i}] disallowed extension {ext!r}: {src}")
        path = repo_root / str(src).lstrip("/")
        if not path.is_file():
            errors.append(f"[{i}] missing file: {src}")

    if errors:
        print(f"playlist validation failed ({len(errors)} issue(s)):", file=sys.stderr)
        for line in errors[:20]:
            print("  " + line, file=sys.stderr)
        if len(errors) > 20:
            print(f"  ... and {len(errors) - 20} more", file=sys.stderr)
        return 1

    print(f"OK: {len(tracks)} tracks, all files present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
