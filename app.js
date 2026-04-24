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

  const likeEndpoint = (cfg.likeEndpoint || "").trim();
  const likeSecret = cfg.likeSecret || "";
  const likeCooldownMs = 2800;
  let likeLastSent = 0;

  const el = {
    player: document.getElementById("player"),
    panel: document.getElementById("radio-panel"),
    now: document.getElementById("now-playing"),
    hint: document.getElementById("path-hint"),
    status: document.getElementById("status"),
    timeDisplay: document.getElementById("time-display"),
    btnPlay: document.getElementById("btn-play"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    btnLike: document.getElementById("btn-like"),
    volume: document.getElementById("volume"),
  };

  const GLOW_HZ_BASS_LOW = 40;
  const GLOW_HZ_BASS_HIGH = 200;
  const GLOW_FFT_SIZE = 2048;
  const GLOW_ANALYSER_SMOOTHING = 0.72;
  const GLOW_SPREAD_MIN = 44;
  const GLOW_SPREAD_MAX = 100;
  const GLOW_ALPHA_MIN = 0.22;
  const GLOW_ALPHA_MAX = 0.52;
  const GLOW_SMOOTH_ATTACK = 0.38;
  const GLOW_SMOOTH_RELEASE = 0.1;
  const GLOW_BASS_GAIN = 1.35;

  // Same-origin media (default RADIO_CONFIG) works with createMediaElementSource.
  // Do not set audio.crossOrigin unless every track URL sends ACAO; otherwise the graph can fail.

  /** @type {AudioContext|null} */
  let glowAudioCtx = null;
  /** @type {AnalyserNode|null} */
  let glowAnalyser = null;
  /** @type {Uint8Array|null} */
  let glowFreqBuf = null;
  let glowGraphCreated = false;
  let glowGraphOk = false;
  let glowInitFailed = false;
  let glowRafId = 0;
  let glowEnv = 0;

  /** @type {{ title: string, src: string }[]} */
  let tracks = [];
  /** @type {number[]} */
  let order = [];
  let orderIndex = 0;
  let playing = false;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 3;

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

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  function updateTimeDisplay() {
    if (!el.timeDisplay) return;
    const cur = el.player.currentTime;
    const dur = el.player.duration;
    el.timeDisplay.textContent =
      formatTime(cur) + " / " + formatTime(dur);
  }

  function updatePrevButtonState() {
    if (!el.btnPrev) return;
    el.btnPrev.disabled = orderIndex <= 0;
  }

  function resetGlowCss() {
    if (!el.panel) return;
    el.panel.style.removeProperty("--glow-spread");
    el.panel.style.removeProperty("--glow-alpha");
  }

  function stopGlowLoop() {
    if (glowRafId) {
      cancelAnimationFrame(glowRafId);
      glowRafId = 0;
    }
    glowEnv = 0;
    resetGlowCss();
  }

  function glowBassEnergy01() {
    if (!glowGraphOk || !glowAnalyser || !glowFreqBuf || !glowAudioCtx) return 0;
    glowAnalyser.getByteFrequencyData(glowFreqBuf);
    const nyquist = glowAudioCtx.sampleRate / 2;
    const hzPerBin = nyquist / glowFreqBuf.length;
    let i0 = Math.floor(GLOW_HZ_BASS_LOW / hzPerBin);
    let i1 = Math.ceil(GLOW_HZ_BASS_HIGH / hzPerBin);
    i0 = Math.max(0, Math.min(i0, glowFreqBuf.length - 1));
    i1 = Math.max(i0 + 1, Math.min(i1, glowFreqBuf.length));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += glowFreqBuf[i];
    const avg = sum / (i1 - i0) / 255;
    const v = avg * GLOW_BASS_GAIN;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function glowSmoothToward(raw) {
    const coef =
      raw > glowEnv ? GLOW_SMOOTH_ATTACK : GLOW_SMOOTH_RELEASE;
    glowEnv += (raw - glowEnv) * coef;
    if (glowEnv < 0) glowEnv = 0;
    else if (glowEnv > 1) glowEnv = 1;
    return glowEnv;
  }

  function glowApplyCss(energy01) {
    if (!el.panel) return;
    const spread =
      GLOW_SPREAD_MIN + energy01 * (GLOW_SPREAD_MAX - GLOW_SPREAD_MIN);
    const alpha =
      GLOW_ALPHA_MIN + energy01 * (GLOW_ALPHA_MAX - GLOW_ALPHA_MIN);
    el.panel.style.setProperty("--glow-spread", spread + "px");
    el.panel.style.setProperty("--glow-alpha", String(alpha));
  }

  function tickGlow() {
    glowRafId = 0;
    if (!glowGraphOk || !glowAnalyser || el.player.paused) {
      resetGlowCss();
      return;
    }
    if (document.visibilityState === "visible") {
      const raw = glowBassEnergy01();
      const sm = glowSmoothToward(raw);
      glowApplyCss(sm);
    }
    glowRafId = requestAnimationFrame(tickGlow);
  }

  function startGlowLoop() {
    if (!glowGraphOk || el.player.paused) return;
    if (glowRafId) cancelAnimationFrame(glowRafId);
    glowRafId = requestAnimationFrame(tickGlow);
  }

  async function initGlowGraphOnFirstPlay() {
    if (glowInitFailed) return;
    if (glowGraphCreated) {
      if (glowAudioCtx && glowAudioCtx.state === "suspended") {
        try {
          await glowAudioCtx.resume();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        glowInitFailed = true;
        return;
      }
      glowAudioCtx = new Ctx();
      const source = glowAudioCtx.createMediaElementSource(el.player);
      glowAnalyser = glowAudioCtx.createAnalyser();
      glowAnalyser.fftSize = GLOW_FFT_SIZE;
      glowAnalyser.smoothingTimeConstant = GLOW_ANALYSER_SMOOTHING;
      source.connect(glowAnalyser);
      glowAnalyser.connect(glowAudioCtx.destination);
      glowFreqBuf = new Uint8Array(glowAnalyser.frequencyBinCount);
      glowGraphCreated = true;
      glowGraphOk = true;
      if (glowAudioCtx.state === "suspended") {
        await glowAudioCtx.resume();
      }
    } catch (err) {
      glowInitFailed = true;
      glowGraphOk = false;
      glowAnalyser = null;
      glowFreqBuf = null;
      if (glowAudioCtx) {
        try {
          glowAudioCtx.close();
        } catch (e2) {
          /* ignore */
        }
        glowAudioCtx = null;
      }
      console.warn("Renders Radio: Web Audio graph failed.", err);
    }
  }

  function configureLikeButton() {
    if (!el.btnLike) return;
    if (!likeEndpoint) {
      el.btnLike.disabled = true;
      el.btnLike.title = "Like: set likeEndpoint in config.js (see like-worker-cloudflare.js)";
      return;
    }
    el.btnLike.disabled = false;
    el.btnLike.title = "Send anonymous like for this track";
  }

  function sendLike() {
    if (!likeEndpoint || !el.btnLike) return;
    const t = currentTrack();
    if (!t) return;
    const now = Date.now();
    if (now - likeLastSent < likeCooldownMs) {
      setStatus("Wait a moment before another like.", false);
      return;
    }
    likeLastSent = now;
    const headers = { "Content-Type": "application/json" };
    if (likeSecret) headers["X-Like-Secret"] = likeSecret;
    const body = {
      title: String(t.title).slice(0, 220),
      src: String(t.src).slice(0, 400),
    };
    fetch(likeEndpoint, {
      method: "POST",
      mode: "cors",
      headers: headers,
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) throw new Error("Like HTTP " + r.status);
        setStatus("Like sent (anonymous).", false);
      })
      .catch(() => {
        setStatus("Could not send like (check endpoint / CORS).", true);
      });
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
        consecutiveErrors = 0;
        el.now.textContent = currentTrack().title;
        el.hint.textContent = currentTrack().src;
        setStatus(tracks.length + " tracks in rotation");
        configureLikeButton();
        updatePrevButtonState();
        updateTimeDisplay();
      });
  }

  function playCurrent() {
    const t = currentTrack();
    if (!t) return;
    stopGlowLoop();
    el.player.src = t.src;
    el.now.textContent = t.title;
    el.hint.textContent = t.src;
    updatePrevButtonState();
    if (el.timeDisplay) {
      el.timeDisplay.textContent = "0:00 / --:--";
    }
    (async () => {
      try {
        await initGlowGraphOnFirstPlay();
        await el.player.play();
        playing = true;
        consecutiveErrors = 0;
        el.btnPlay.textContent = "Pause";
        setStatus("");
        startGlowLoop();
      } catch (_err) {
        playing = false;
        el.btnPlay.textContent = "Play";
        stopGlowLoop();
        setStatus("Playback blocked or failed — try clicking Play again.", true);
      }
    })();
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

  function goPrev() {
    if (!tracks.length || orderIndex <= 0) return;
    orderIndex--;
    playCurrent();
  }

  el.btnPlay.addEventListener("click", () => {
    if (!tracks.length) return;
    if (playing) {
      el.player.pause();
      playing = false;
      el.btnPlay.textContent = "Play";
      stopGlowLoop();
      return;
    }
    if (!el.player.src) {
      playCurrent();
    } else {
      (async () => {
        try {
          await initGlowGraphOnFirstPlay();
          await el.player.play();
          playing = true;
          el.btnPlay.textContent = "Pause";
          startGlowLoop();
        } catch (_err) {
          stopGlowLoop();
          setStatus("Could not resume playback.", true);
        }
      })();
    }
  });

  if (el.btnNext) {
    el.btnNext.addEventListener("click", () => {
      advance();
    });
  }

  if (el.btnPrev) {
    el.btnPrev.addEventListener("click", () => {
      goPrev();
    });
  }

  if (el.btnLike) {
    el.btnLike.addEventListener("click", () => {
      sendLike();
    });
  }
  configureLikeButton();

  el.volume.addEventListener("input", () => {
    el.player.volume = Number(el.volume.value);
  });

  el.player.volume = Number(el.volume.value);

  el.player.addEventListener("pause", () => {
    stopGlowLoop();
  });

  el.player.addEventListener("ended", () => {
    advance();
  });

  el.player.addEventListener("error", () => {
    const err = el.player.error;
    const code = err ? err.code : 0;
    consecutiveErrors++;
    stopGlowLoop();
    if (consecutiveErrors >= maxConsecutiveErrors) {
      playing = false;
      el.btnPlay.textContent = "Play";
      setStatus(
        "Several tracks failed to load (wrong paths or missing files). " +
          "If the site is under /YourRepo/, remove mediaBase: '/' from config.js " +
          "or set mediaBase to '/YourRepo/'. Media error code: " +
          code,
        true
      );
      return;
    }
    setStatus("Track failed to load, skipping (" + consecutiveErrors + ").", true);
    advance();
  });

  el.player.addEventListener("loadeddata", () => {
    consecutiveErrors = 0;
  });

  el.player.addEventListener("timeupdate", updateTimeDisplay);
  el.player.addEventListener("loadedmetadata", updateTimeDisplay);
  el.player.addEventListener("durationchange", updateTimeDisplay);

  loadPlaylist().catch((e) => {
    el.now.textContent = "Could not load playlist";
    setStatus(String(e.message || e), true);
  });
})();
