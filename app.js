(function () {
  "use strict";

  const LOG = "[RozKyler Archives]";

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

  /** Skip tagged vocal / rap versions (filename convention). */
  function isExcludedRadioTitle(title) {
    const n = String(title || "").toLowerCase();
    return n === "skylight_2" || n.includes("vocals") || n.includes("(rap)");
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
  const showPathHint = !!cfg.debug;
  /** Per track (`src`): block another like for this long (persists across revisits). */
  const LIKE_PER_TRACK_COOLDOWN_MS = 10 * 60 * 1000;
  const LIKE_STORAGE_KEY = "RozKylerArchives_trackLikeAt_v1";
  const VOLUME_STORAGE_KEY = "RozKylerArchives_volume_v1";
  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
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
    btnPlayLabel: document.getElementById("btn-play-label"),
    btnPrev: document.getElementById("btn-prev"),
    btnNext: document.getElementById("btn-next"),
    btnShuffle: document.getElementById("btn-shuffle"),
    btnLike: document.getElementById("btn-like"),
    volume: document.getElementById("volume"),
    variantList: document.getElementById("variant-list"),
    trackPickerList: document.getElementById("track-picker-list"),
    trackPickerSearch: document.getElementById("track-picker-search"),
    trackPickerClear: document.getElementById("track-picker-clear"),
    trackPickerHint: document.getElementById("track-picker-hint"),
    timeProgress: document.getElementById("time-progress"),
    historyList: document.getElementById("history-list"),
    historyEmpty: document.getElementById("history-empty"),
    nowTitleDetails: document.getElementById("now-title-details"),
    btnShareHistory: document.getElementById("btn-share-history"),
    shareHistorySheet: document.getElementById("share-history-sheet"),
    shareHistoryBackdrop: document.getElementById("share-history-backdrop"),
    shareHistoryNative: document.getElementById("share-history-native"),
    shareHistoryCopy: document.getElementById("share-history-copy"),
    shareHistoryDownload: document.getElementById("share-history-download"),
    shareHistoryClose: document.getElementById("share-history-close"),
  };

  const HISTORY_CAP = 80;

  let trackPickerFilter = "";

  const PLAY_HISTORY_SHARE_INTRO = "I listened to RozKyler radio:\n\n";
  const PLAY_HISTORY_SHARE_FILENAME = "rozkylerradio-play-history.txt";

  /** @type {Element | null} */
  let shareSheetReturnFocus = null;

  function formatDisplayTitle(title) {
    return String(title || "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setPlayButtonState(isPlaying) {
    if (!el.btnPlay) return;
    const wasPlaying = el.btnPlay.classList.contains("is-playing");
    el.btnPlay.classList.toggle("is-playing", isPlaying);
    el.btnPlay.classList.toggle("is-paused", !isPlaying);
    const label = isPlaying ? "Pause" : "Play";
    el.btnPlay.setAttribute("aria-label", label);
    if (el.btnPlayLabel) el.btnPlayLabel.textContent = label;
    if (isPlaying && !wasPlaying && !prefersReducedMotion) {
      el.btnPlay.classList.add("is-pulse");
      window.setTimeout(() => {
        if (el.btnPlay) el.btnPlay.classList.remove("is-pulse");
      }, 380);
    }
  }

  function setNowPlayingTitle(title) {
    if (!el.now) return;
    const next = formatDisplayTitle(title);
    if (el.now.textContent === next) return;
    if (prefersReducedMotion) {
      el.now.textContent = next;
      return;
    }
    el.now.classList.remove("is-entered");
    el.now.classList.add("is-changing");
    window.setTimeout(() => {
      el.now.textContent = next;
      el.now.classList.remove("is-changing");
      el.now.classList.add("is-entered");
      window.setTimeout(() => {
        el.now.classList.remove("is-entered");
      }, 220);
    }, 130);
  }

  function triggerLikePop() {
    if (!el.btnLike || prefersReducedMotion) return;
    el.btnLike.classList.remove("is-popping");
    void el.btnLike.offsetWidth;
    el.btnLike.classList.add("is-popping");
    window.setTimeout(() => {
      if (el.btnLike) el.btnLike.classList.remove("is-popping");
    }, 450);
  }

  const SHARE_SHEET_CLOSE_MS = 280;

  function setPanelLoading(loading) {
    if (!el.panel) return;
    el.panel.classList.toggle("is-loading", loading);
    el.panel.classList.toggle("is-ready", !loading);
    el.panel.setAttribute("aria-busy", loading ? "true" : "false");
  }

  function updateVariantDetailsState() {
    if (!el.nowTitleDetails) return;
    const t = currentTrack();
    if (!t) return;
    const key = trackGroupKey(t.title);
    const indices = groupToIndices.get(key);
    const single = !indices || indices.length <= 1;
    el.nowTitleDetails.classList.toggle("is-single-variant", single);
    if (single) el.nowTitleDetails.open = false;
  }

  function updateTrackPickerClearButton() {
    if (!el.trackPickerClear) return;
    const hasFilter = trackPickerFilter.trim().length > 0;
    el.trackPickerClear.hidden = !hasFilter;
  }

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

  /** @type {string|null} */
  let highlightHistoryKey = null;

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
    highlightHistoryKey = trackGroupKey(t.title);
    while (playHistory.length > HISTORY_CAP) playHistory.pop();
    renderHistory();
  }

  function getPlayHistoryShareText() {
    if (!playHistory.length) return PLAY_HISTORY_SHARE_INTRO.trimEnd();
    const lines = [];
    for (let i = playHistory.length - 1; i >= 0; i--) {
      const e = playHistory[i];
      const when = formatHistoryWhen(e.at);
      lines.push(
        when
          ? "- " + formatDisplayTitle(e.title) + " (" + when + ")"
          : "- " + formatDisplayTitle(e.title)
      );
    }
    return PLAY_HISTORY_SHARE_INTRO + lines.join("\n") + "\n";
  }

  function openShareHistorySheet() {
    if (!el.shareHistorySheet || !playHistory.length) return;
    shareSheetReturnFocus = document.activeElement;
    el.shareHistorySheet.hidden = false;
    requestAnimationFrame(() => {
      el.shareHistorySheet.classList.add("is-open");
      if (el.shareHistoryNative) el.shareHistoryNative.focus();
    });
  }

  function closeShareHistorySheet() {
    if (!el.shareHistorySheet || el.shareHistorySheet.hidden) return;
    el.shareHistorySheet.classList.remove("is-open");
    const finish = () => {
      el.shareHistorySheet.hidden = true;
      if (
        shareSheetReturnFocus &&
        typeof shareSheetReturnFocus.focus === "function"
      ) {
        try {
          shareSheetReturnFocus.focus();
        } catch (_e) {
          /* ignore */
        }
      }
      shareSheetReturnFocus = null;
    };
    if (prefersReducedMotion) {
      finish();
      return;
    }
    window.setTimeout(finish, SHARE_SHEET_CLOSE_MS);
  }

  async function sharePlayHistoryNative() {
    const text = getPlayHistoryShareText();
    const title = "RozKyler radio — play history";
    try {
      const file = new File([text], PLAY_HISTORY_SHARE_FILENAME, {
        type: "text/plain",
      });
      if (navigator.share) {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ title: title, text: text, files: [file] });
          closeShareHistorySheet();
          return;
        }
        await navigator.share({ title: title, text: text });
        closeShareHistorySheet();
        return;
      }
    } catch (err) {
      if (err && /** @type {{ name?: string }} */ (err).name === "AbortError") {
        return;
      }
      radioLog("warn", "navigator.share failed:", err);
    }
    setStatus("Sharing is not available here — try Copy or Download.", true);
  }

  async function copyPlayHistoryText() {
    const text = getPlayHistoryShareText();
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Play history copied to clipboard.", false);
      closeShareHistorySheet();
    } catch (err) {
      radioLog("warn", "clipboard.writeText failed:", err);
      setStatus("Could not copy — use Download.", true);
    }
  }

  function downloadPlayHistoryTxt() {
    const text = getPlayHistoryShareText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = PLAY_HISTORY_SHARE_FILENAME;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Download started.", false);
    closeShareHistorySheet();
  }

  function renderHistory() {
    const listEl = el.historyList;
    const emptyEl = el.historyEmpty;
    if (!listEl || !emptyEl) return;
    if (el.btnShareHistory) {
      el.btnShareHistory.disabled = playHistory.length === 0;
    }
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
          label: formatDisplayTitle(stripVersionSuffixes(e.title) || e.title),
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
      const groupKey = trackGroupKey(g.plays[0].title);
      if (highlightHistoryKey && groupKey === highlightHistoryKey) {
        det.classList.add("is-new");
        highlightHistoryKey = null;
      }
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
        t1.textContent = formatDisplayTitle(p.title);
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
      btn.textContent = formatDisplayTitle(tr.title);
      if (ti === curIdx) {
        btn.classList.add("is-current");
        btn.disabled = true;
        btn.setAttribute("aria-current", "true");
        btn.setAttribute("aria-label", "Now playing: " + formatDisplayTitle(tr.title));
      } else {
        btn.addEventListener("click", () => {
          playTrackByIndex(ti);
          if (el.nowTitleDetails) el.nowTitleDetails.open = false;
        });
      }
      li.appendChild(btn);
      ul.appendChild(li);
    }
    updateVariantDetailsState();
  }

  function renderTrackPickerList() {
    const ul = el.trackPickerList;
    if (!ul) return;
    ul.innerHTML = "";
    if (!tracks.length) return;

    const filter = trackPickerFilter.trim().toLowerCase();
    const sortedIndices = tracks
      .map((_, i) => i)
      .sort((a, b) =>
        tracks[a].title.localeCompare(tracks[b].title, undefined, {
          sensitivity: "base",
        })
      );

    /** @type {Map<string, number[]>} */
    const pickerGroups = new Map();
    for (const ti of sortedIndices) {
      const label =
        formatDisplayTitle(stripVersionSuffixes(tracks[ti].title)) ||
        formatDisplayTitle(tracks[ti].title);
      const key = trackGroupKey(tracks[ti].title);
      if (!pickerGroups.has(key)) {
        pickerGroups.set(key, { label: label, indices: [] });
      }
      pickerGroups.get(key).indices.push(ti);
    }

    const curIdx = order[orderIndex];
    let visibleCount = 0;

    for (const group of pickerGroups.values()) {
      const label = group.label;
      const indices = group.indices;
      const haystack = (
        label +
        " " +
        indices.map((i) => tracks[i].title).join(" ")
      ).toLowerCase();
      if (filter && !haystack.includes(filter)) continue;

      visibleCount++;
      const ti = indices.includes(curIdx) ? curIdx : indices[0];
      const tr = tracks[ti];
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      const titleSpan = document.createElement("span");
      titleSpan.textContent = label;
      btn.appendChild(titleSpan);
      if (indices.length > 1) {
        const meta = document.createElement("span");
        meta.className = "track-picker-variant-meta";
        meta.textContent =
          indices.length === 1 ? "" : indices.length + " versions";
        btn.appendChild(meta);
      }
      if (ti === curIdx) {
        btn.classList.add("is-current");
        btn.disabled = true;
        btn.setAttribute("aria-current", "true");
        btn.setAttribute("aria-label", "Now playing: " + formatDisplayTitle(tr.title));
      } else {
        btn.addEventListener("click", () => {
          playTrackByIndex(ti);
        });
      }
      li.appendChild(btn);
      ul.appendChild(li);
      if (ti === curIdx && !filter) {
        requestAnimationFrame(() => {
          btn.scrollIntoView({
            block: "nearest",
            behavior: prefersReducedMotion ? "auto" : "smooth",
          });
        });
      }
    }

    updateTrackPickerClearButton();

    if (el.trackPickerHint) {
      if (!filter) {
        el.trackPickerHint.textContent = "Tap a title to play it (A–Z).";
      } else if (!visibleCount) {
        el.trackPickerHint.textContent = "No tracks match your search.";
      } else {
        el.trackPickerHint.textContent =
          visibleCount === 1
            ? "1 match — tap to play."
            : visibleCount + " matches — tap to play.";
      }
    }
  }

  function playTrackByIndex(trackIndex) {
    if (trackIndex < 0 || trackIndex >= tracks.length) return;
    order[orderIndex] = trackIndex;
    playCurrent();
  }

  function shuffleRotation() {
    if (!tracks.length) return;
    const curIdx = order[orderIndex];
    rebuildOrder(curIdx);
    const newPos = order.indexOf(curIdx);
    orderIndex = newPos >= 0 ? newPos : 0;
    if (el.btnShuffle) {
      el.btnShuffle.classList.add("is-spinning");
      window.setTimeout(() => {
        if (el.btnShuffle) el.btnShuffle.classList.remove("is-spinning");
      }, 450);
    }
    setStatus("New shuffle order — next track is a surprise.", false);
    updatePrevButtonState();
    renderVariantList();
    updateVariantDetailsState();
    renderTrackPickerList();
    updateMediaSession();
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
    el.status.classList.toggle("is-visible", !!msg);
  }

  function updatePathHint(src) {
    if (!el.hint) return;
    if (!showPathHint) {
      el.hint.hidden = true;
      el.hint.textContent = "";
      return;
    }
    el.hint.hidden = false;
    el.hint.textContent = src || "";
  }

  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const t = currentTrack();
    if (!t) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: formatDisplayTitle(t.title),
        artist: "RozKyler Archives",
        album: "Archive radio",
      });
    } catch (_e) {
      /* MediaMetadata unsupported */
    }
    const setHandler = (action, fn) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch (_e) {
        /* action unsupported */
      }
    };
    setHandler("play", () => {
      void el.player.play();
    });
    setHandler("pause", () => {
      el.player.pause();
    });
    setHandler("previoustrack", () => {
      goPrev();
    });
    setHandler("nexttrack", () => {
      advance();
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    updateMediaSessionPosition();
  }

  function updateMediaSessionPosition() {
    if (!("mediaSession" in navigator)) return;
    if (typeof navigator.mediaSession.setPositionState !== "function") return;
    const dur = el.player.duration;
    const cur = el.player.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: el.player.playbackRate || 1,
        position: Math.min(cur, dur),
      });
    } catch (_e) {
      /* unsupported */
    }
  }

  function seekFromClientX(clientX) {
    const bar = el.timeProgress;
    const dur = el.player.duration;
    if (!bar || !Number.isFinite(dur) || dur <= 0) return;
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.player.currentTime = ratio * dur;
    updateTimeDisplay();
  }

  function restoreVolume() {
    if (!el.volume) return;
    try {
      const saved = localStorage.getItem(VOLUME_STORAGE_KEY);
      if (saved == null) return;
      const v = Number(saved);
      if (!Number.isFinite(v)) return;
      const clamped = Math.min(1, Math.max(0, v));
      el.volume.value = String(clamped);
      el.player.volume = clamped;
    } catch (_e) {
      /* private mode / blocked storage */
    }
  }

  function persistVolume() {
    if (!el.volume) return;
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, el.volume.value);
    } catch (_e) {
      /* ignore */
    }
  }

  function updateTrackCountDisplay() {
    const node = el.trackCount;
    if (!node) return;
    const n = tracks.length;
    if (!n) {
      node.textContent = "";
      return;
    }
    const families = groupToIndices.size;
    if (n === 1) {
      node.textContent = "1 track in rotation";
      return;
    }
    node.textContent =
      n +
      " tracks" +
      (families < n ? " · " + families + " families" : "") +
      " in rotation";
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
    updateMediaSessionPosition();
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
    if (prefersReducedMotion || !glowGraphOk || !glowAnalyser || el.player.paused) {
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
    if (prefersReducedMotion || !glowGraphOk || el.player.paused) return;
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
      el.btnLike.classList.remove("is-liked");
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
      el.btnLike.classList.add("is-liked");
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
    el.btnLike.classList.remove("is-liked");
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
        triggerLikePop();
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
    setPanelLoading(true);
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
        tracks = list
          .map((t) => {
            const src = typeof t === "string" ? t : t.src || t.url || t.file;
            const title = (typeof t === "object" && t.title) || titleFromSrc(src);
            const rel = src.replace(/^\//, "");
            const fullSrc = /^https?:\/\//i.test(src)
              ? src
              : joinUrl(mediaPrefix, encodePathSegments(rel));
            return { title, src: fullSrc };
          })
          .filter((t) => !isExcludedRadioTitle(t.title));
        if (!tracks.length) {
          throw new Error("Playlist is empty");
        }
        rebuildOrder();
        rebuildGroupIndex();
        consecutiveErrors = 0;
        setNowPlayingTitle(currentTrack().title);
        updatePathHint(currentTrack().src);
        updateTrackCountDisplay();
        setStatus("");
        setPanelLoading(false);
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
        renderTrackPickerList();
        renderHistory();
        updateMediaSession();
      });
  }

  function playCurrent() {
    const t = currentTrack();
    if (!t) return;
    recordPlayHistory();
    stopGlowLoop();
    el.player.src = t.src;
    setNowPlayingTitle(t.title);
    updatePathHint(t.src);
    renderVariantList();
    renderTrackPickerList();
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
        setPlayButtonState(true);
        setStatus("");
        startGlowLoop();
        updateMediaSession();
      } catch (err) {
        playing = false;
        setPlayButtonState(false);
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
      setPlayButtonState(false);
      stopGlowLoop();
      updateMediaSession();
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
          setPlayButtonState(true);
          startGlowLoop();
          updateMediaSession();
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

  if (el.btnShareHistory) {
    el.btnShareHistory.addEventListener("click", () => {
      openShareHistorySheet();
    });
  }
  if (el.shareHistoryBackdrop) {
    el.shareHistoryBackdrop.addEventListener("click", () => {
      closeShareHistorySheet();
    });
  }
  if (el.shareHistoryClose) {
    el.shareHistoryClose.addEventListener("click", () => {
      closeShareHistorySheet();
    });
  }
  if (el.shareHistoryNative) {
    el.shareHistoryNative.addEventListener("click", () => {
      void sharePlayHistoryNative();
    });
  }
  if (el.shareHistoryCopy) {
    el.shareHistoryCopy.addEventListener("click", () => {
      void copyPlayHistoryText();
    });
  }
  if (el.shareHistoryDownload) {
    el.shareHistoryDownload.addEventListener("click", () => {
      downloadPlayHistoryTxt();
    });
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!el.shareHistorySheet || el.shareHistorySheet.hidden) return;
    closeShareHistorySheet();
  });

  el.volume.addEventListener("input", () => {
    el.player.volume = Number(el.volume.value);
    persistVolume();
  });

  restoreVolume();
  el.player.volume = Number(el.volume.value);

  if (el.btnShuffle) {
    el.btnShuffle.addEventListener("click", () => {
      shuffleRotation();
    });
  }

  if (el.trackPickerSearch) {
    el.trackPickerSearch.addEventListener("input", () => {
      trackPickerFilter = el.trackPickerSearch.value;
      renderTrackPickerList();
    });
  }

  if (el.trackPickerClear) {
    el.trackPickerClear.addEventListener("click", () => {
      trackPickerFilter = "";
      if (el.trackPickerSearch) {
        el.trackPickerSearch.value = "";
        el.trackPickerSearch.focus();
      }
      renderTrackPickerList();
    });
  }

  if (el.timeProgress) {
    el.timeProgress.addEventListener("click", (ev) => {
      seekFromClientX(ev.clientX);
    });
    el.timeProgress.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      el.timeProgress.classList.add("is-seeking");
      el.timeProgress.setPointerCapture(ev.pointerId);
      seekFromClientX(ev.clientX);
    });
    el.timeProgress.addEventListener("pointermove", (ev) => {
      if (!el.timeProgress.classList.contains("is-seeking")) return;
      seekFromClientX(ev.clientX);
    });
    const endSeek = (ev) => {
      if (!el.timeProgress.classList.contains("is-seeking")) return;
      el.timeProgress.classList.remove("is-seeking");
      try {
        el.timeProgress.releasePointerCapture(ev.pointerId);
      } catch (_e) {
        /* ignore */
      }
    };
    el.timeProgress.addEventListener("pointerup", endSeek);
    el.timeProgress.addEventListener("pointercancel", endSeek);
  }

  document.addEventListener("keydown", (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
    const typing =
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      (target && target.isContentEditable);
    if (typing) return;
    if (!tracks.length) return;

    if (ev.key === "/" && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      if (el.trackPickerSearch) el.trackPickerSearch.focus();
      return;
    }
    if (ev.key === " " || ev.code === "Space") {
      ev.preventDefault();
      el.btnPlay.click();
      return;
    }
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      advance();
      return;
    }
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      goPrev();
    }
  });

  el.player.addEventListener("play", () => {
    playing = true;
    setPlayButtonState(true);
    updateMediaSession();
  });

  el.player.addEventListener("pause", () => {
    playing = false;
    if (el.btnPlay) setPlayButtonState(false);
    stopGlowLoop();
    updateMediaSession();
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
      setPlayButtonState(false);
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

  setPlayButtonState(false);

  loadPlaylist().catch((e) => {
    setPanelLoading(false);
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
