(function () {
  "use strict";

  const cfg = window.RADIO_CONFIG || {};
  const rawBase = cfg.basePath || "";
  const basePath = rawBase ? rawBase.replace(/\/?$/, "/") : "";
  const playlistUrl = joinUrl(basePath, cfg.playlistUrl || "playlist.json");

  function normalizeUrlPrefix(p) {
    if (p === "" || p == null) return "";
    if (p === "/") return "/";
    return String(p).replace(/\/?$/, "/");
  }

  const mediaPrefix =
    cfg.mediaBase !== undefined && cfg.mediaBase !== null
      ? normalizeUrlPrefix(cfg.mediaBase)
      : basePath;

  const el = {
    player: document.getElementById("player"),
    now: document.getElementById("now-playing"),
    hint: document.getElementById("path-hint"),
    status: document.getElementById("status"),
    btnPlay: document.getElementById("btn-play"),
    btnSkip: document.getElementById("btn-skip"),
    volume: document.getElementById("volume"),
  };

  /** @type {{ title: string, src: string }[]} */
  let tracks = [];
  /** @type {number[]} */
  let order = [];
  let orderIndex = 0;
  let playing = false;

  function joinUrl(base, path) {
    if (!path) return base || "";
    if (/^https?:\/\//i.test(path)) return path;
    const b = base || "";
    const p = path.replace(/^\//, "");
    return b + p;
  }

  function encodePathSegments(relPath) {
    return relPath
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function rebuildOrder(avoidTrackIndex) {
    order = tracks.map((_, i) => i);
    shuffleInPlace(order);
    if (
      avoidTrackIndex != null &&
      order.length > 1 &&
      order[0] === avoidTrackIndex
    ) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    orderIndex = 0;
  }

  function currentTrack() {
    if (!tracks.length) return null;
    const idx = order[orderIndex];
    return tracks[idx];
  }

  function setStatus(msg, isError) {
    el.status.textContent = msg || "";
    el.status.classList.toggle("error", !!isError);
  }

  function titleFromSrc(src) {
    const seg = src.split("/").filter(Boolean);
    const file = seg[seg.length - 1] || src;
    return decodeURIComponent(file.replace(/\.(mp3|wav|flac|m4a|ogg)$/i, ""));
  }

  function loadPlaylist() {
    return fetch(playlistUrl)
      .then((r) => {
        if (!r.ok) throw new Error("Playlist HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        const list = data.tracks || data;
        if (!Array.isArray(list) || !list.length) {
          throw new Error("Playlist is empty");
        }
        tracks = list.map((t) => {
          const src = typeof t === "string" ? t : t.src || t.url || t.file;
          const title = (typeof t === "object" && t.title) || titleFromSrc(src);
          const rel = src.replace(/^\//, "");
          const fullSrc = /^https?:\/\//i.test(src)
            ? src
            : joinUrl(mediaPrefix, encodePathSegments(rel));
          return { title, src: fullSrc };
        });
        rebuildOrder();
        el.now.textContent = currentTrack().title;
        el.hint.textContent = currentTrack().src;
        setStatus(tracks.length + " tracks in rotation");
      });
  }

  function playCurrent() {
    const t = currentTrack();
    if (!t) return;
    el.player.src = t.src;
    el.now.textContent = t.title;
    el.hint.textContent = t.src;
    el.player.play().then(
      () => {
        playing = true;
        el.btnPlay.textContent = "Pause";
        setStatus("");
      },
      () => {
        playing = false;
        el.btnPlay.textContent = "Play";
        setStatus("Playback blocked or failed — try clicking Play again.", true);
      }
    );
  }

  function advance() {
    if (!tracks.length) return;
    const prevTrackIdx = order[orderIndex];
    orderIndex++;
    if (orderIndex >= order.length) {
      rebuildOrder(prevTrackIdx);
    }
    playCurrent();
  }

  el.btnPlay.addEventListener("click", () => {
    if (!tracks.length) return;
    if (playing) {
      el.player.pause();
      playing = false;
      el.btnPlay.textContent = "Play";
      return;
    }
    if (!el.player.src) {
      playCurrent();
    } else {
      el.player
        .play()
        .then(() => {
          playing = true;
          el.btnPlay.textContent = "Pause";
        })
        .catch(() => setStatus("Could not resume playback.", true));
    }
  });

  el.btnSkip.addEventListener("click", () => {
    advance();
  });

  el.volume.addEventListener("input", () => {
    el.player.volume = Number(el.volume.value);
  });

  el.player.volume = Number(el.volume.value);

  el.player.addEventListener("ended", () => {
    advance();
  });

  el.player.addEventListener("error", () => {
    setStatus("Audio error — skipping.", true);
    advance();
  });

  loadPlaylist().catch((e) => {
    el.now.textContent = "Could not load playlist";
    setStatus(String(e.message || e), true);
  });
})();
