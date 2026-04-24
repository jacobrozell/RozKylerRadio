(function () {
  "use strict";

  const LOG = "[Renders Radio]";

  /**
   * @param {"log"|"info"|"warn"|"error"} level
   * @param {string} message
   * @param {unknown} [detail]
   */
  function radioLog(level, message, detail) {
    const line = LOG + " " + message;
    if (detail === undefined) {
      (console[level] || console.log).call(console, line);
      return;
    }
    (console[level] || console.log).call(console, line, detail);
  }

  /** Human-readable label for HTMLMediaElement.error.code (MEDIA_ERR_*). */
  function describeMediaErrorCode(code) {
    switch (code) {
      case 1:
        return "ABORTED (1) — load was aborted";
      case 2:
        return "NETWORK (2) — network error while fetching";
      case 3:
        return "DECODE (3) — decode failed or corrupt file";
      case 4:
        return "SRC_NOT_SUPPORTED (4) — format not supported or bad URL";
      default:
        return code ? "UNKNOWN (" + code + ")" : "no error object";
    }
  }

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
  /** Per track (`src`): block another like for this long (persists across revisits). */
  const LIKE_PER_TRACK_COOLDOWN_MS = 10 * 60 * 1000;
  const LIKE_STORAGE_KEY = "RendersRadio_trackLikeAt_v1";
  let likeCooldownUiTimer = 0;
  let likeRequestInFlight = false;

  const el = {
    player: document.getElementById("player"),
    panel: document.getElementById("radio-panel"),
    now: document.getElementById("now-playing"),
    hint: document.getElementById("path-hint"),
    status: document.getElementById("status"),
    trackCount: document.getElementById("track-count"),
    timeDisplay: document.getElementById("time-display"),
    timeBlock: document.getElementById("time-block"),
    btnPlay: document.getElementById("btn-play"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    btnLike: document.getElementById("btn-like"),
    volume: document.getElementById("volume"),
    variantList: document.getElementById("variant-list"),
    historyList: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    nowTitleDetails: document.getElementById("now-title-details"),
  };

  const HISTORY_CAP = 80;

  /** Suffixes stripped from the end of titles to group “versions” (fade mix N, _2, v2, …). */
  const VERSION_TAIL_RES = [
    /\s*[-–—]\s*fade\s+mix\s*\d+\s*$/i,
    /\s+fade\s+mix\s*\d+\s*$/i,
    /\s*[-–—]\s*mix\s*\d+\s*$/i,
    /\s*\(\s*mix\s*\d+\s*\)\s*$/i,
    /\s*[-–—]\s*(?:take|part)\s*\d+\s*$/i,
    /\s*[-–—]\s*v(?:ersion)?\s*\d+\s*$/i,
    /\s+v\d+\s*$/i,
    // Trailing _2 / _03 etc., but not …beat_2 (different beats in one session, e.g. rap_beat_2).
    /(?<!beat)_\d+\s*$/i,
    /\s*\(\s*v\s*\d+\s*\)\s*$/i,
    /\s*\(\s*alt(?:ernate)?\s*\)\s*$/i,
    /\s*\(\s*demo\s*\)\s*$/i,
  ];

  /**
   * @param {string} raw
   * @returns {string}
   */
  function stripVersionSuffixes(raw) {
    let s = String(raw).trim().replace(/\s+/g, " ");
    if (!s) return s;
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      for (const re of VERSION_TAIL_RES) {
        const next = s.replace(re, "").trim();
        if (next !== s) {
          s = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return s || String(raw).trim();
  }

  /**
   * @param {string} title
   * @returns {string}
   */
  function trackGroupKey(title) {
    return stripVersionSuffixes(title).toLowerCase();
  }

  /** @type {Map<string, number[]>} */
  let groupToIndices = new Map();

  function rebuildGroupIndex() {
    groupToIndices = new Map();
    for (let i = 0; i < tracks.length; i++) {
      const k = trackGroupKey(tracks[i].title);
      if (!groupToIndices.has(k)) groupToIndices.set(k, []);
      groupToIndices.get(k).push(i);
    }
    for (const arr of groupToIndices.values()) {
      arr.sort((a, b) =>
        tracks[a].title.localeCompare(tracks[b].title, undefined, {
          sensitivity: "base",
        })
      );
    }
  }

  /** @type {{ trackIndex: number, title: string, src: string, at: number }[]} */
  let playHistory = [];

  function formatHistoryWhen(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (_e) {
      return "";
    }
  }

  function recordPlayHistory() {
    const idx = order[orderIndex];
    const t = tracks[idx];
    if (!t) return;
    const last = playHistory[0];
    if (last && last.trackIndex === idx) return;
    playHistory.unshift({
      trackIndex: idx,
      title: t.title,
      src: t.src,
      at: Date.now(),
    });
    while (playHistory.length > HISTORY_CAP) playHistory.pop();
    renderHistory();
  }

  function renderHistory() {
    const listEl = el.historyList;
    const emptyEl = el.historyEmpty;
    if (!listEl || !emptyEl) return;
    if (!playHistory.length) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      listEl.innerHTML = "";
      return;
    }
    emptyEl.hidden = true;
    listEl.hidden = false;
    /** @type {Map<string, { label: string, plays: typeof playHistory }>} */
    const groups = new Map();
    for (const e of playHistory) {
      const k = trackGroupKey(e.title);
      if (!groups.has(k)) {
        groups.set(k, {
          label: stripVersionSuffixes(e.title) || e.title,
          plays: [],
        });
      }
      groups.get(k).plays.push(e);
    }
    const ordered = [...groups.values()].sort((a, b) => {
      const ma = Math.max(...a.plays.map((p) => p.at));
      const mb = Math.max(...b.plays.map((p) => p.at));
      return mb - ma;
    });
    listEl.innerHTML = "";
    for (const g of ordered) {
      const det = document.createElement("details");
      det.className = "history-group";
      const sum = document.createElement("summary");
      sum.className = "history-group-summary";
      const titleSpan = document.createElement("span");
      titleSpan.className = "history-group-title";
      titleSpan.textContent = g.label;
      const meta = document.createElement("span");
      meta.className = "history-group-meta";
      meta.textContent =
        g.plays.length === 1 ? "1 play" : g.plays.length + " plays";
      sum.appendChild(titleSpan);
      sum.appendChild(meta);
      const body = document.createElement("div");
      body.className = "history-group-body";
      const ol = document.createElement("ul");
      ol.className = "history-group-plays";
      for (const p of g.plays) {
        const li = document.createElement("li");
        const t1 = document.createElement("span");
        t1.className = "history-play-title";
        t1.textContent = p.title;
        const t2 = document.createElement("span");
        t2.className = "history-play-when";
        t2.textContent = formatHistoryWhen(p.at);
        li.appendChild(t1);
        li.appendChild(t2);
        ol.appendChild(li);
      }
      body.appendChild(ol);
      det.appendChild(sum);
      det.appendChild(body);
      listEl.appendChild(det);
    }
  }

  function renderVariantList() {
    const ul = el.variantList;
    if (!ul) return;
    ul.innerHTML = "";
    const t = currentTrack();
    if (!t || !tracks.length) return;
    const key = trackGroupKey(t.title);
    const indices = groupToIndices.get(key);
    if (!indices || !indices.length) return;
    const curIdx = order[orderIndex];
    for (const ti of indices) {
      const tr = tracks[ti];
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = tr.title;
      if (ti === curIdx) {
        btn.classList.add("is-current");
        btn.disabled = true;
        btn.setAttribute("aria-current", "true");
        btn.setAttribute("aria-label", "Now playing: " + tr.title);
      } else {
        btn.addEventListener("click", () => {
          playTrackByIndex(ti);
          if (el.nowTitleDetails) el.nowTitleDetails.open = false;
        });
      }
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function playTrackByIndex(trackIndex) {
    if (trackIndex < 0 || trackIndex >= tracks.length) return;
    order[orderIndex] = trackIndex;
    playCurrent();
  }

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

  function updateTrackCountDisplay() {
    const node = el.trackCount;
    if (!node) return;
    const n = tracks.length;
    if (!n) {
      node.textContent = "";
      return;
    }
    node.textContent =
      n === 1 ? "1 track in rotation" : n + " tracks in rotation";
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
    if (el.timeBlock) {
      const p =
        Number.isFinite(dur) && dur > 0
          ? Math.min(1, Math.max(0, cur / dur))
          : 0;
      el.timeBlock.style.setProperty("--progress", String(p));
    }
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
      radioLog(
        "warn",
        "Web Audio glow graph failed (playback may still work). Common causes: cross-origin media without CORS, or browser blocked AudioContext.",
        err
      );
    }
  }

  function clearLikeCooldownUiTimer() {
    if (likeCooldownUiTimer) {
      clearTimeout(likeCooldownUiTimer);
      likeCooldownUiTimer = 0;
    }
  }

  /** @returns {Record<string, number>} */
  function readLikeAtBySrc() {
    try {
      const raw = localStorage.getItem(LIKE_STORAGE_KEY);
      if (!raw) return {};
      const o = JSON.parse(raw);
      return typeof o === "object" && o !== null && !Array.isArray(o) ? o : {};
    } catch (_e) {
      return {};
    }
  }

  /** @param {Record<string, number>} map */
  function writeLikeAtBySrc(map) {
    try {
      localStorage.setItem(LIKE_STORAGE_KEY, JSON.stringify(map));
    } catch (_e) {
      /* quota or private mode */
    }
  }

  /**
   * @param {Record<string, number>} map
   * @param {number} now
   * @returns {boolean} whether map was mutated
   */
  function pruneExpiredLikeEntries(map, now) {
    const cutoff = now - LIKE_PER_TRACK_COOLDOWN_MS;
    let changed = false;
    for (const k of Object.keys(map)) {
      if (map[k] < cutoff) {
        delete map[k];
        changed = true;
      }
    }
    return changed;
  }

  /** @param {number} now */
  function getLikeMapPruned(now) {
    const map = readLikeAtBySrc();
    if (pruneExpiredLikeEntries(map, now)) {
      writeLikeAtBySrc(map);
    }
    return map;
  }

  /**
   * @param {string} src
   * @param {number} now
   */
  function remainingLikeCooldownMs(src, now) {
    const map = getLikeMapPruned(now);
    const at = map[src];
    if (!at) return 0;
    const left = LIKE_PER_TRACK_COOLDOWN_MS - (now - at);
    return left > 0 ? left : 0;
  }

  /** @param {string} src */
  function recordSuccessfulLikeForSrc(src) {
    const now = Date.now();
    const map = getLikeMapPruned(now);
    map[src] = now;
    writeLikeAtBySrc(map);
  }

  /** @param {number} ms */
  function formatLikeCooldownRemaining(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m === 0) return r + "s";
    if (r === 0) return m + "m";
    return m + "m " + r + "s";
  }

  function updateLikeButtonForCurrentTrack() {
    if (!el.btnLike || !likeEndpoint) return;
    clearLikeCooldownUiTimer();
    const t = currentTrack();
    if (!t) {
      el.btnLike.disabled = true;
      el.btnLike.title = "No track loaded";
      return;
    }
    if (likeRequestInFlight) {
      el.btnLike.disabled = true;
      el.btnLike.title = "Sending like…";
      return;
    }
    const now = Date.now();
    const left = remainingLikeCooldownMs(t.src, now);
    if (left > 0) {
      el.btnLike.disabled = true;
      el.btnLike.title =
        "You liked this track recently. Like again in " +
        formatLikeCooldownRemaining(left) +
        ".";
      const wait = Math.min(left + 80, 2147483647);
      likeCooldownUiTimer = setTimeout(function refreshLikeUi() {
        likeCooldownUiTimer = 0;
        updateLikeButtonForCurrentTrack();
      }, wait);
      return;
    }
    el.btnLike.disabled = false;
    el.btnLike.title = "Send anonymous like for this track";
  }

  function configureLikeButton() {
    if (!el.btnLike) return;
    if (!likeEndpoint) {
      clearLikeCooldownUiTimer();
      el.btnLike.disabled = true;
      el.btnLike.title = "Like: set likeEndpoint in config.js (see like-worker-cloudflare.js)";
      return;
    }
    updateLikeButtonForCurrentTrack();
  }

  function sendLike() {
    if (!likeEndpoint || !el.btnLike) return;
    const t = currentTrack();
    if (!t) return;
    const now = Date.now();
    if (remainingLikeCooldownMs(t.src, now) > 0) {
      setStatus("You already liked this track recently.", false);
      updateLikeButtonForCurrentTrack();
      return;
    }
    if (likeRequestInFlight) return;

    likeRequestInFlight = true;
    updateLikeButtonForCurrentTrack();

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
        if (!r.ok) {
          radioLog(
            "error",
            "Like request failed: HTTP " +
              r.status +
              " " +
              r.statusText +
              ". Check Worker URL, secret header, and CORS.",
            { endpoint: likeEndpoint, title: body.title }
          );
          throw new Error("Like HTTP " + r.status);
        }
        recordSuccessfulLikeForSrc(t.src);
        setStatus("Like sent (anonymous).", false);
      })
      .catch((err) => {
        if (err && String(err.message || err).indexOf("Like HTTP") === -1) {
          radioLog(
            "error",
            "Like request error (network, CORS blocked, or invalid URL):",
            err
          );
        }
        setStatus("Could not send like (check endpoint / CORS).", true);
      })
      .finally(() => {
        likeRequestInFlight = false;
        updateLikeButtonForCurrentTrack();
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
        rebuildGroupIndex();
        consecutiveErrors = 0;
        el.now.textContent = currentTrack().title;
        el.hint.textContent = currentTrack().src;
        updateTrackCountDisplay();
        setStatus("");
        radioLog(
          "info",
          "Playlist loaded: " +
            tracks.length +
            " tracks. playlistUrl=" +
            playlistUrl +
            " mediaPrefix=" +
            (mediaPrefix || "(same as page)")
        );
        configureLikeButton();
        updatePrevButtonState();
        updateTimeDisplay();
        renderVariantList();
        renderHistory();
      });
  }

  function playCurrent() {
    const t = currentTrack();
    if (!t) return;
    recordPlayHistory();
    stopGlowLoop();
    el.player.src = t.src;
    el.now.textContent = t.title;
    el.hint.textContent = t.src;
    renderVariantList();
    updatePrevButtonState();
    updateLikeButtonForCurrentTrack();
    if (el.timeDisplay) {
      el.timeDisplay.textContent = "0:00 / --:--";
    }
    if (el.timeBlock) {
      el.timeBlock.style.setProperty("--progress", "0");
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
      } catch (err) {
        playing = false;
        el.btnPlay.textContent = "Play";
        stopGlowLoop();
        radioLog(
          "error",
          "play() failed (autoplay policy, missing src, or decode). Track:",
          { title: t.title, src: t.src, error: err }
        );
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
        } catch (err) {
          stopGlowLoop();
          radioLog("error", "resume play() failed:", err);
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
    const t = currentTrack();
    radioLog("error", "<audio> error: " + describeMediaErrorCode(code), {
      mediaErrorCode: code,
      src: el.player.src || "(empty)",
      trackTitle: t ? t.title : "(none)",
      consecutiveFailures: consecutiveErrors + 1,
      hint:
        "If paths 404 on GitHub Pages, check RADIO_CONFIG.basePath / mediaBase in config.js.",
    });
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
    if (el.trackCount) el.trackCount.textContent = "";
    const msg = String(e && e.message ? e.message : e);
    radioLog(
      "error",
      "Failed to load playlist. URL: " +
        playlistUrl +
        " — " +
        msg +
        " (use a local static server, not file://; check basePath in config.js.)",
      e
    );
    setStatus(msg, true);
  });
})();
