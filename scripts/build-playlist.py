#!/usr/bin/env python3
"""Build playlist.json for RozKylerRadio from the Renders tree."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path


def is_excluded(title: str) -> bool:
    n = title.lower()
    return n == "skylight_2" or "vocals" in n or "(rap)" in n


def main() -> None:
    parser = argparse.ArgumentParser(description="Build playlist.json from Renders/")
    parser.add_argument(
        "--scan-root",
        default=None,
        help="Folder to recurse (default: ./Renders next to repo root)",
    )
    parser.add_argument(
        "--http-root",
        default=None,
        help="HTTP document root for URL paths (default: repo root)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output JSON path (default: ./playlist.json)",
    )
    parser.add_argument(
        "--extensions",
        nargs="+",
        default=[".mp3"],
        help="File extensions to include (default: .mp3)",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    scan_root = Path(args.scan_root or repo_root / "Renders").resolve()
    http_root = Path(args.http_root or repo_root).resolve()
    out_file = Path(args.out or repo_root / "playlist.json")
    extensions = {
        (e if e.startswith(".") else f".{e}").lower() for e in args.extensions
    }

    if not scan_root.is_dir():
        raise SystemExit(f"Scan root not found: {scan_root}")

    tracks: list[dict[str, str]] = []
    for path in sorted(scan_root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in extensions:
            continue
        title = path.stem
        if is_excluded(title):
            continue
        try:
            rel = path.resolve().relative_to(http_root).as_posix()
        except ValueError as exc:
            raise SystemExit(
                f"File is outside http root:\n  file: {path}\n  root: {http_root}"
            ) from exc
        tracks.append({"title": title, "src": rel})

    payload = {
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "count": len(tracks),
        "tracks": tracks,
    }
    out_file.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(tracks)} tracks to {out_file}")
    print(f"ScanRoot: {scan_root}")
    print(f"HttpRoot: {http_root}")


if __name__ == "__main__":
    main()
