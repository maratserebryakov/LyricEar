;(function () {
  /* ── helpers ── */
  const $ = (s, r = document) => r.querySelector(s);

  function esc(s) {
    return String(s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function toast(msg, small) {
    const el = $("#toast");
    if (!el) return;
    el.innerHTML = small
      ? `<div>${esc(msg)}</div><small>${esc(small)}</small>`
      : `<div>${esc(msg)}</div>`;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function clamp01(x) {
    x = Number(x);
    return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /* ══════════════════════════════════════
     IndexedDB — media blob cache
     ══════════════════════════════════════ */
  const IDB_NAME = "lyricear-media";
  const IDB_STORE = "files";
  const IDB_VERSION = 1;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSave(songId, blob, fileName, mimeType) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        store.put(
          { blob, name: fileName, type: mimeType, savedAt: Date.now() },
          songId
        );
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (e) {
      console.warn("[IDB] save failed:", e);
      return false;
    }
  }

  async function idbLoad(songId) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(songId);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    } catch (e) {
      console.warn("[IDB] load failed:", e);
      return null;
    }
  }

  async function idbDelete(songId) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        store.delete(songId);
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (e) {
      console.warn("[IDB] delete failed:", e);
      return false;
    }
  }

  /* ══════════════════════════════════════
     Spectrogram Engine
     ══════════════════════════════════════ */
  function createSpectrogram(canvas, player) {
    const ctx = canvas.getContext("2d");
    let audioCtx = null;
    let analyser = null;
    let source = null;
    let connected = false;
    let rafId = null;
    let running = false;

    /* ── colour palette: logo-inspired purple gradient ── */
    // silence → deep navy → purple → magenta → pink-white
    const GRADIENT_STOPS = [
      [0.00, 10, 8, 28],
      [0.15, 30, 15, 70],
      [0.30, 70, 20, 120],
      [0.50, 140, 40, 170],
      [0.70, 200, 60, 180],
      [0.85, 240, 120, 200],
      [1.00, 255, 220, 255]
    ];

    /* build a 256-entry lookup table */
    const colorLUT = new Array(256);
    (function buildLUT() {
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let lo = 0, hi = GRADIENT_STOPS.length - 1;
        for (let s = 0; s < GRADIENT_STOPS.length - 1; s++) {
          if (t >= GRADIENT_STOPS[s][0] && t <= GRADIENT_STOPS[s + 1][0]) {
            lo = s; hi = s + 1; break;
          }
        }
        const range = GRADIENT_STOPS[hi][0] - GRADIENT_STOPS[lo][0] || 1;
        const f = (t - GRADIENT_STOPS[lo][0]) / range;
        const r = Math.round(GRADIENT_STOPS[lo][1] + (GRADIENT_STOPS[hi][1] - GRADIENT_STOPS[lo][1]) * f);
        const g = Math.round(GRADIENT_STOPS[lo][2] + (GRADIENT_STOPS[hi][2] - GRADIENT_STOPS[lo][2]) * f);
        const b = Math.round(GRADIENT_STOPS[lo][3] + (GRADIENT_STOPS[hi][3] - GRADIENT_STOPS[lo][3]) * f);
        colorLUT[i] = [r, g, b];
      }
    })();

    let zoomLevel = 1; // 1 = full range, 2 = bottom half, etc.
    const MAX_ZOOM = 4;
    const MIN_ZOOM = 1;

    /* ── connect Web Audio ── */
    function ensureAudio() {
      if (connected) return true;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        analyser.minDecibels = -100;
        analyser.maxDecibels = -20;
        source = audioCtx.createMediaElementSource(player);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        connected = true;
        return true;
      } catch (e) {
        console.warn("[Spectrogram] Web Audio failed:", e);
        return false;
      }
    }

    /* ── drawing state ── */
    let writeX = 0;
    const freqData = new Uint8Array(1024);

    function resetCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgb(${colorLUT[0][0]},${colorLUT[0][1]},${colorLUT[0][2]})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      writeX = 0;
    }

    /* ── main draw column ── */
    function drawColumn() {
      if (!analyser) return;
      analyser.getByteFrequencyData(freqData);

      const W = canvas.width;
      const H = canvas.height;

      /* scroll: shift everything 1px left, draw new column at right */
      if (writeX >= W) {
        const img = ctx.getImageData(1, 0, W - 1, H);
        ctx.putImageData(img, 0, 0);
        writeX = W - 1;
      }

      /* which bins to show based on zoom */
      const totalBins = analyser.frequencyBinCount; // 1024
      const visibleBins = Math.floor(totalBins / zoomLevel);
      const startBin = 0; // always start from lowest frequency

      const imgCol = ctx.createImageData(1, H);
      const d = imgCol.data;

      for (let y = 0; y < H; y++) {
        /* y=0 is top of canvas = highest freq shown */
        const freqIdx = startBin + Math.floor((1 - y / H) * visibleBins);
        const clamped = Math.max(0, Math.min(255, freqData[freqIdx] || 0));
        const c = colorLUT[clamped];
        const off = y * 4;
        d[off] = c[0];
        d[off + 1] = c[1];
        d[off + 2] = c[2];
        d[off + 3] = 255;
      }

      ctx.putImageData(imgCol, writeX, 0);
      writeX++;
    }

    /* ── animation loop ── */
    function loop() {
      if (!running) return;
      drawColumn();
      rafId = requestAnimationFrame(loop);
    }

    function start() {
      if (!ensureAudio()) return;
      if (audioCtx.state === "suspended") audioCtx.resume();
      running = true;
      loop();
    }

    function stop() {
      running = false;
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function clear() {
      stop();
      resetCanvas();
    }

    function zoomIn() {
      if (zoomLevel < MAX_ZOOM) { zoomLevel *= 2; clear(); }
    }

    function zoomOut() {
      if (zoomLevel > MIN_ZOOM) { zoomLevel /= 2; clear(); }
    }

    function getZoomLevel() { return zoomLevel; }

    function destroy() {
      stop();
      if (source) { try { source.disconnect(); } catch {} }
      if (analyser) { try { analyser.disconnect(); } catch {} }
      if (audioCtx) { try { audioCtx.close(); } catch {} }
      connected = false;
    }

    /* handle resize */
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (canvas.offsetParent !== null) resetCanvas();
      }, 200);
    });

    resetCanvas();

    return { start, stop, clear, zoomIn, zoomOut, getZoomLevel, destroy, resetCanvas, ensureAudio };
  }

  /* ── storage consent ── */
  function showStorageConsent() {
    const KEY = "lyricear_storage_ok";
    if (localStorage.getItem(KEY)) return;
    const bar = document.createElement("div");
    bar.id = "storageBanner";
    bar.innerHTML =
      `<span>Этот сайт сохраняет ваш прогресс и медиафайлы в браузере (localStorage + IndexedDB). Никакие данные не передаются на сервер.</span>
       <button id="storageOk">Понятно</button>`;
    document.body.appendChild(bar);
    $("#storageOk").addEventListener("click", () => {
      localStorage.setItem(KEY, "1");
      bar.remove();
    });
  }

  /* ── state helpers ── */
  function normalizeState(s) {
    s.ui = Object.assign(
      { showTranslationByDefault: false, showPhoneticByDefault: false,
        showWhyHeardByDefault: false, showOriginalByDefault: false },
      s.ui || {}
    );
    s.song = s.song || {};
    s.song.media = s.song.media || {};
    if (!Array.isArray(s.items)) s.items = [];
    s.items.forEach((it, i) => {
      if (!it.id) it.id = `${s.song.id || "line"}-${String(i + 1).padStart(3, "0")}`;
      if (!("start" in it)) it.start = null;
      if (!("end" in it)) it.end = null;
      if (typeof it.learned !== "boolean") it.learned = false;
      if (typeof it.confidence !== "number") it.confidence = null;
      if (typeof it.phonetic_user !== "string") it.phonetic_user = "";
    });
  }

  function mergeProgress(remote, local) {
    const out = structuredClone(remote);
    if (local?.ui) out.ui = Object.assign({}, out.ui || {}, local.ui);
    const m = new Map((local.items || []).map(x => [x.id, x]));
    (out.items || []).forEach(it => {
      const l = m.get(it.id);
      if (!l) return;
      it.start  = l.start ?? it.start ?? null;
      it.end    = l.end   ?? it.end   ?? null;
      it.learned = typeof l.learned === "boolean" ? l.learned : it.learned;
      if (l.phonetic_user) it.phonetic_user = l.phonetic_user;
    });
    return out;
  }

  /* ── resolve song from URL ── */
  function getSongSlug() {
    const params = new URLSearchParams(location.search);
    const slug = params.get("song");
    if (slug) return slug;
    const attr = document.documentElement.dataset.songJson;
    if (attr) return attr;
    return null;
  }

  function songSlugToJsonUrl(slug) {
    if (slug.includes("/")) return slug;
    return `data/songs/${slug}.json`;
  }

  /* ══════════════════════════════════════
     SONG PAGE
     ══════════════════════════════════════ */
  async function bootSongPage() {
    const slug = getSongSlug();
    if (!slug) return;

    const SONG_JSON_URL = songSlugToJsonUrl(slug);
    const PREFIX = "lyricear_v1::";

    let state;
    try {
      const remote = await fetchJson(SONG_JSON_URL);
      const key = PREFIX + (remote.song?.id || slug);
      const localRaw = localStorage.getItem(key);
      const local = localRaw ? JSON.parse(localRaw) : null;
      state = local ? mergeProgress(remote, local) : remote;
      state._storageKey = key;
    } catch (e) {
      toast("Не удалось загрузить данные песни", String(e));
      return;
    }
    normalizeState(state);

    const songId = state.song?.id || slug;

    if (state.song?.title) {
      document.title = `${state.song.title} — LyricEar`;
    }

    /* ── DOM refs ── */
    const player         = $("#player");
    const mediaPick      = $("#mediaPick");
    const btnLoadLocal   = $("#btnLoadLocal");
    const btnLoadYaDisk  = $("#btnLoadYaDisk");
    const btnForgetMedia = $("#btnForgetMedia");
    const mediaName      = $("#mediaName");
    const lamp           = $("#mediaLamp");
    const elNow          = $("#tNow");
    const btnPlaySeg     = $("#btnPlaySeg");
    const btnStart       = $("#btnStart");
    const btnEnd         = $("#btnEnd");
    const btnClear       = $("#btnClear");
    const loopToggle     = $("#loopToggle");
    const autoNextToggle = $("#autoNextToggle");
    const globalShowOrig  = $("#globalShowOrig");
    const globalShowTrans = $("#globalShowTrans");
    const globalShowPhon  = $("#globalShowPhon");
    const globalShowWhy   = $("#globalShowWhy");
    const linesHost      = $("#lines");
    const saveIndicator  = $("#saveIndicator");

    let activeIndex = 0;
    let loopTimer = null;

    /* ── header ── */
    function applyHeader() {
      const t = $("#songTitle");  if (t) t.textContent = state.song?.title || "—";
      const a = $("#songArtist"); if (a) a.textContent = state.song?.artist || "—";
      const l = $("#songLang");   if (l) l.textContent = state.song?.languageName || state.song?.language || "—";
      const h = $("#songHint");   if (h) h.textContent = state.song?.hint || "";
    }
    applyHeader();

    /* ── lamp ── */
    function setLamp(source) {
      if (!lamp) return;
      lamp.className = "lamp";
      if      (source === "local")  { lamp.classList.add("lamp-green"); lamp.title = "Файл из кэша браузера"; }
      else if (source === "cached") { lamp.classList.add("lamp-green"); lamp.title = "Файл из кэша (IndexedDB)"; }
      else if (source === "remote") { lamp.classList.add("lamp-red");   lamp.title = "Файл из интернета"; }
      else                          { lamp.classList.add("lamp-off");   lamp.title = "Медиа не загружено"; }
    }
    setLamp("none");

    /* ── media name display ── */
    function showMediaName(name) {
      if (mediaName) {
        mediaName.textContent = name || "";
        mediaName.style.display = name ? "inline" : "none";
      }
    }
    showMediaName("");

    /* ── forget media button ── */
    function updateForgetBtn(visible) {
      if (btnForgetMedia) {
        btnForgetMedia.style.display = visible ? "inline-block" : "none";
      }
    }
    updateForgetBtn(false);

    function setSrc(url, source) {
      player.src = url;
      player.load();
      setLamp(source);
    }

    /* ── save with flash ── */
    let saveTimer = null;
    function save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { localStorage.setItem(state._storageKey, JSON.stringify(state)); } catch {}
        if (saveIndicator) {
          saveIndicator.classList.add("flash");
          setTimeout(() => saveIndicator.classList.remove("flash"), 600);
        }
      }, 300);
    }

    /* ── media type detection ── */
    const AUDIO_EXT = /\.(mp3|m4a|ogg|wav|flac|aac|wma|opus|webm)$/i;
    const VIDEO_EXT = /\.(mp4|mkv|webm|avi|mov|m4v|ogv)$/i;

    function detectMediaType(filename, mimeType) {
      if (mimeType) {
        if (mimeType.startsWith("video/")) return "video";
        if (mimeType.startsWith("audio/")) return "audio";
      }
      if (VIDEO_EXT.test(filename)) return "video";
      if (AUDIO_EXT.test(filename)) return "audio";
      return "video";
    }

    function applyPlayerMode(mode) {
      if (mode === "video") {
        player.classList.remove("is-audio");
        player.classList.add("is-video");
      } else {
        player.classList.remove("is-video");
        player.classList.add("is-audio");
      }
    }
    applyPlayerMode("audio");

    /* ── load blob into player + save to IDB ── */
    async function loadBlob(blob, fileName, mimeType, source, persist) {
      if (player._objUrl) {
        try { URL.revokeObjectURL(player._objUrl); } catch {}
      }
      const url = URL.createObjectURL(blob);
      player._objUrl = url;
      const mode = detectMediaType(fileName, mimeType);
      applyPlayerMode(mode);
      setSrc(url, source);
      showMediaName(fileName);
      updateForgetBtn(true);
      stopPulse();

      if (persist) {
        const ok = await idbSave(songId, blob, fileName, mimeType);
        if (ok) {
          toast(
            mode === "video" ? "🎬 Видео сохранено" : "🎵 Аудио сохранено",
            fileName + " — при следующем открытии подхватится автоматически"
          );
        } else {
          toast(
            mode === "video" ? "🎬 Открыто видео" : "🎵 Открыто аудио",
            fileName + " (не удалось кэшировать)"
          );
        }
      }
    }

    /* ── try restore from IDB on boot ── */
    async function tryRestoreMedia() {
      const cached = await idbLoad(songId);
      if (!cached || !cached.blob) return false;
      await loadBlob(cached.blob, cached.name, cached.type, "cached", false);
      toast("📦 Медиа восстановлено из кэша", cached.name);
      return true;
    }

    /* ── pulse ── */
    function stopPulse()  { if (btnLoadLocal) btnLoadLocal.classList.remove("pulse"); }
    function startPulse() { if (btnLoadLocal) btnLoadLocal.classList.add("pulse"); }

    /* ── local file ── */
    if (btnLoadLocal && mediaPick) {
      btnLoadLocal.addEventListener("click", () => mediaPick.click());
      mediaPick.addEventListener("change", () => {
        const f = mediaPick.files?.[0];
        if (!f) return;
        loadBlob(f, f.name, f.type, "local", true);
      });
    }

    /* ── forget media ── */
    if (btnForgetMedia) {
      btnForgetMedia.addEventListener("click", async () => {
        if (!confirm("Удалить сохранённый медиафайл из кэша браузера?")) return;
        await idbDelete(songId);
        if (player._objUrl) {
          try { URL.revokeObjectURL(player._objUrl); } catch {}
          player._objUrl = null;
        }
        player.removeAttribute("src");
        player.load();
        applyPlayerMode("audio");
        setLamp("none");
        showMediaName("");
        updateForgetBtn(false);
        if (spectrogram) spectrogram.clear();
        toast("🗑 Медиа удалено из кэша");
      });
    }

    player.addEventListener("loadeddata", () => {
      stopPulse();
      if (player.videoHeight > 0) applyPlayerMode("video");
    });

    /* ── Yandex.Disk ── */
    if (btnLoadYaDisk) {
      const yadiskUrl = state.song?.media?.yadisk;
      if (!yadiskUrl) {
        btnLoadYaDisk.style.display = "none";
      } else {
        btnLoadYaDisk.addEventListener("click", () => {
          window.open(yadiskUrl, "yadisk", "width=700,height=500,left=300,top=100");
          startPulse();
          toast("📥 Скачайте файл с Яндекс.Диска", "Затем нажмите мигающую кнопку «📁 Выбрать файл»");
        });
      }
    }

    /* ── player events ── */
    player.addEventListener("timeupdate", () => {
      if (elNow) elNow.textContent = (player.currentTime || 0).toFixed(2);
    });
    player.addEventListener("loadedmetadata", () => {
      if (btnStart) btnStart.disabled = false;
      if (btnEnd)   btnEnd.disabled   = false;
      renderSegStatus();
    });
    player.addEventListener("error", () => {
      const err = player.error ? "код " + player.error.code : "неизвестно";
      toast("Ошибка загрузки медиа", err);
      setLamp("none");
    });

    /* ══════════════════════════════════════
       Spectrogram UI
       ══════════════════════════════════════ */
    const specWrap    = $("#spectrogramWrap");
    const specCanvas  = $("#spectrogramCanvas");
    const specToggle  = $("#spectrogramToggle");
    const specZoomIn  = $("#specZoomIn");
    const specZoomOut = $("#specZoomOut");
    const specZoomLbl = $("#specZoomLabel");

    let spectrogram = null;

    if (specCanvas && player) {
      spectrogram = createSpectrogram(specCanvas, player);
    }

    /* collapse / expand */
    if (specToggle && specWrap) {
      specToggle.addEventListener("click", () => {
        const collapsed = specWrap.classList.toggle("collapsed");
        specToggle.textContent = collapsed ? "📊 Спектрограмма ▸" : "📊 Спектрограмма ▾";
        if (!collapsed && spectrogram) spectrogram.resetCanvas();
      });
    }

    /* zoom */
    function updateZoomLabel() {
      if (specZoomLbl && spectrogram) {
        specZoomLbl.textContent = `×${spectrogram.getZoomLevel()}`;
      }
    }
    if (specZoomIn && spectrogram) {
      specZoomIn.addEventListener("click", () => { spectrogram.zoomIn(); updateZoomLabel(); });
    }
    if (specZoomOut && spectrogram) {
      specZoomOut.addEventListener("click", () => { spectrogram.zoomOut(); updateZoomLabel(); });
    }

    /* start/stop spectrogram with playback */
    player.addEventListener("play", () => {
      if (spectrogram) {
        spectrogram.ensureAudio();
        spectrogram.clear();
        spectrogram.start();
      }
    });
    player.addEventListener("pause", () => { if (spectrogram) spectrogram.stop(); });
    player.addEventListener("ended", () => { if (spectrogram) spectrogram.stop(); });
    player.addEventListener("seeked", () => { if (spectrogram && !player.paused) spectrogram.clear(); });

    /* ── segment controls ── */
    function renderSegStatus() {
      const segEl = $("#segStatus");
      if (!segEl) return;
      const it = state.items[activeIndex];
      const s = it?.start, e = it?.end;
      segEl.innerHTML =
        `<span class="pill">Строка: <span class="mono">${activeIndex + 1}/${state.items.length}</span></span>
         <span class="pill">Start: <span class="mono">${s == null ? "—" : Number(s).toFixed(2)}</span></span>
         <span class="pill">End: <span class="mono">${e == null ? "—" : Number(e).toFixed(2)}</span></span>
         <span class="pill">${it?.learned ? "✓ выучено" : "… в работе"}</span>`;
      const ready = s != null && e != null && Number(e) > Number(s);
      if (btnPlaySeg) btnPlaySeg.disabled = !ready;
      if (btnClear)   btnClear.disabled   = !(s != null || e != null);
      if (btnStart)   btnStart.disabled   = !(player?.readyState >= 1);
      if (btnEnd)     btnEnd.disabled     = !(player?.readyState >= 1);
    }

    function stopLoop() {
      if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    }

    function playSegment() {
      const it = state.items[activeIndex];
      const s = it?.start, e = it?.end;
      if (!(s != null && e != null && Number(e) > Number(s))) {
        toast("Нужны Start и End"); return;
      }
      stopLoop();
      player.currentTime = Number(s);
      /* spectrogram clears on play event */
      player.play().catch(() => {});
      loopTimer = setInterval(() => {
        if (!player || player.paused) return;
        if (player.currentTime >= Number(e) - 0.03) {
          if (loopToggle && loopToggle.checked) {
            player.currentTime = Number(s);
            if (spectrogram) spectrogram.clear();
          } else {
            stopLoop();
            player.pause();
            if (autoNextToggle && autoNextToggle.checked) {
              const next = Math.min(activeIndex + 1, state.items.length - 1);
              if (next !== activeIndex) {
                setActive(next, true);
                const ni = state.items[next];
                if (ni?.start != null && ni?.end != null && Number(ni.end) > Number(ni.start))
                  setTimeout(() => playSegment(), 120);
              }
            }
          }
        }
      }, 30);
    }

    if (btnPlaySeg) btnPlaySeg.addEventListener("click", playSegment);

    if (btnStart) btnStart.addEventListener("click", () => {
      const it = state.items[activeIndex];
      it.start = Number(player.currentTime.toFixed(2));
      if (it.end != null && Number(it.end) <= Number(it.start)) it.end = null;
      save(); renderLines();
    });

    if (btnEnd) btnEnd.addEventListener("click", () => {
      const it = state.items[activeIndex];
      it.end = Number(player.currentTime.toFixed(2));
      if (it.start != null && Number(it.end) <= Number(it.start)) {
        toast("End должен быть больше Start"); it.end = null;
      }
      save(); renderLines();
    });

    if (btnClear) btnClear.addEventListener("click", () => {
      const it = state.items[activeIndex];
      it.start = null; it.end = null;
      save(); renderLines();
    });

    /* ── active line ── */
    function setActive(idx, seek) {
      activeIndex = Math.max(0, Math.min(idx, state.items.length - 1));
      renderLines();
      const it = state.items[activeIndex];
      if (seek && it?.start != null && Number.isFinite(it.start))
        player.currentTime = Math.max(0, Number(it.start));
    }

    /* ── render lines ── */
    function renderLines() {
      const showOrig  = globalShowOrig?.checked  || false;
      const showTrans = globalShowTrans?.checked || false;
      const showPhon  = globalShowPhon?.checked  || false;
      const showWhy   = globalShowWhy?.checked   || false;

      state.ui.showOriginalByDefault    = showOrig;
      state.ui.showTranslationByDefault = showTrans;
      state.ui.showPhoneticByDefault    = showPhon;
      state.ui.showWhyHeardByDefault    = showWhy;

      linesHost.innerHTML = "";

      state.items.forEach((it, idx) => {
        const isActive = idx === activeIndex;
        const hasTime = it.start != null && it.end != null && Number(it.end) > Number(it.start);

        const line = document.createElement("div");
        line.className = "line" + (isActive ? " active" : "") + (it.learned ? " learned" : "");
        line.dataset.idx = idx;

        const header = document.createElement("div");
        header.className = "line-header";

        const num = document.createElement("span");
        num.className = "line-num";
        num.textContent = String(idx + 1);

        const userInput = document.createElement("input");
        userInput.type = "text";
        userInput.className = "user-heard";
        userInput.placeholder = "Как услышал(а)…";
        userInput.value = it.phonetic_user || "";
        userInput.addEventListener("input", () => { it.phonetic_user = userInput.value; save(); });
        userInput.addEventListener("click", e => e.stopPropagation());
        userInput.addEventListener("focus", e => e.stopPropagation());

        header.appendChild(num);
        header.appendChild(userInput);

        const origRow = document.createElement("div");
        origRow.className = "orig-row";
        let origRevealed = showOrig;

        const origText = document.createElement("span");
        origText.className = "orig-text";
        origText.textContent = it.text || "—";
        origText.style.display = origRevealed ? "inline" : "none";

        const btnReveal = document.createElement("button");
        btnReveal.className = "tiny btn-reveal";
        btnReveal.textContent = origRevealed ? "👁 Скрыть" : "👁 Показать";
        btnReveal.addEventListener("click", e => {
          e.stopPropagation();
          origRevealed = !origRevealed;
          origText.style.display = origRevealed ? "inline" : "none";
          btnReveal.textContent = origRevealed ? "👁 Скрыть" : "👁 Показать";
        });

        origRow.appendChild(btnReveal);
        origRow.appendChild(origText);

        const phonRow = document.createElement("div");
        phonRow.className = "sub sub-phon" + (showPhon ? " visible" : "");
        if (it.phonetic) {
          phonRow.innerHTML =
            `<div class="subCard"><b>👂 Автор слышит:</b> <span class="mono phon-author">${esc(it.phonetic)}</span></div>`;
        }

        const transRow = document.createElement("div");
        transRow.className = "sub sub-trans" + (showTrans ? " visible" : "");
        if (it.translation) {
          transRow.innerHTML =
            `<div class="subCard"><span class="muted">Перевод:</span> ${esc(it.translation)}</div>`;
        }

        const whyRow = document.createElement("div");
        whyRow.className = "sub sub-why" + (showWhy ? " visible" : "");
        if (it.why) {
          const conf = typeof it.confidence === "number"
            ? ` <span class="pill">≈${(clamp01(it.confidence) * 100).toFixed(0)}%</span>` : "";
          whyRow.innerHTML =
            `<div class="subCard">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <b>🧠 Почему так слышится:</b>${conf}
              </div>
              <div style="margin-top:4px;">${esc(it.why)}</div>
            </div>`;
        }

        const actions = document.createElement("div");
        actions.className = "line-actions";

        function mkBtn(text, cls, fn) {
          const b = document.createElement("button");
          b.className = cls; b.textContent = text;
          b.addEventListener("click", e => { e.stopPropagation(); fn(); });
          return b;
        }

        actions.appendChild(mkBtn("Выбрать", "tiny btn-primary", () => setActive(idx, true)));
        if (hasTime) actions.appendChild(mkBtn("▶", "tiny", () => { setActive(idx, false); playSegment(); }));
        if (it.phonetic) actions.appendChild(mkBtn("👂", "tiny", () => phonRow.classList.toggle("visible")));
        actions.appendChild(mkBtn("💬", "tiny", () => transRow.classList.toggle("visible")));
        if (it.why) actions.appendChild(mkBtn("🧠", "tiny", () => whyRow.classList.toggle("visible")));
        actions.appendChild(mkBtn(
          it.learned ? "✓ Выучено" : "Выучено",
          "tiny " + (it.learned ? "btn-good" : ""),
          () => { it.learned = !it.learned; save(); renderLines(); }
        ));

        line.appendChild(header);
        line.appendChild(origRow);
        line.appendChild(phonRow);
        line.appendChild(transRow);
        line.appendChild(whyRow);
        line.appendChild(actions);
        line.addEventListener("click", () => setActive(idx, true));
        linesHost.appendChild(line);
      });

      renderSegStatus();
      save();
    }

    /* ── reset progress ── */
    const btnResetProgress = $("#btnResetProgress");
    if (btnResetProgress) {
      btnResetProgress.addEventListener("click", async () => {
        if (!confirm("Сбросить весь прогресс по этой песне? Это нельзя отменить.")) return;
        try {
          const remote = await fetchJson(SONG_JSON_URL);
          const key = state._storageKey;
          state = remote;
          state._storageKey = key;
          normalizeState(state);
          save();
          applyHeader();
          setActive(0, false);
          toast("✅ Прогресс сброшен");
        } catch (e) {
          toast("Не удалось сбросить", String(e));
        }
      });
    }

    /* ── global toggles ── */
    if (globalShowOrig)  globalShowOrig.checked  = !!state.ui.showOriginalByDefault;
    if (globalShowTrans) globalShowTrans.checked = !!state.ui.showTranslationByDefault;
    if (globalShowPhon)  globalShowPhon.checked  = !!state.ui.showPhoneticByDefault;
    if (globalShowWhy)   globalShowWhy.checked   = !!state.ui.showWhyHeardByDefault;

    [globalShowOrig, globalShowTrans, globalShowPhon, globalShowWhy].forEach(el => {
      if (el) el.addEventListener("change", renderLines);
    });

    /* ── start ── */
    renderLines();
    setActive(0, false);

    /* ── restore cached media ── */
    tryRestoreMedia().then(restored => {
      if (!restored) startPulse();
    });

    /* ── keyboard shortcuts ── */
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const key = e.key.toLowerCase();

      if (key === " " || key === "spacebar") {
        e.preventDefault();
        if (player.paused) player.play().catch(() => {}); else player.pause();
      }
      if (key === "s") {
        e.preventDefault();
        if (btnStart) btnStart.click();
        toast("⏱ Start = " + player.currentTime.toFixed(2));
      }
      if (key === "e") {
        e.preventDefault();
        if (btnEnd) btnEnd.click();
        const next = Math.min(activeIndex + 1, state.items.length - 1);
        if (next !== activeIndex) setTimeout(() => setActive(next, false), 100);
        toast("⏱ End = " + player.currentTime.toFixed(2) + " → строка " + (next + 1));
      }
      if (key === "arrowdown" || key === "n") {
        e.preventDefault(); setActive(Math.min(activeIndex + 1, state.items.length - 1), false);
      }
      if (key === "arrowup" || key === "p") {
        e.preventDefault(); setActive(Math.max(activeIndex - 1, 0), false);
      }
      if (key === "r") { e.preventDefault(); playSegment(); }
    });

    toast("⌨ S=Start, E=End, Space=Play, ↑↓=строки, R=фрагмент");
  }

  /* ══════════════════════════════════════
     HOME PAGE
     ══════════════════════════════════════ */
  async function bootHome() {
    const root = document.documentElement;
    if (!root.dataset.catalog) return;

    const list = $("#songsList");
    const langSel = $("#langFilter");
    const search = $("#q");

    let catalog;
    try { catalog = await fetchJson(root.dataset.catalog); }
    catch (e) { toast("Не удалось загрузить каталог", String(e)); return; }

    const songs = catalog.songs || [];
    const langs = catalog.languages || [];

    if (langSel) {
      langSel.innerHTML = `<option value="">Все языки</option>` +
        langs.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join("");
    }

    function render() {
      const q = (search?.value || "").trim().toLowerCase();
      const lang = langSel?.value || "";
      const filtered = songs.filter(s => {
        const okLang = !lang || s.language === lang;
        const hay = `${s.title} ${s.artist} ${s.languageName || ""}`.toLowerCase();
        return okLang && (!q || hay.includes(q));
      });
      const countEl = $("#count");
      if (countEl) countEl.textContent = String(filtered.length);
      if (!list) return;
      list.innerHTML = "";
      filtered.forEach(s => {
        const a = document.createElement("a");
        a.className = "songCard"; a.href = s.url;
        a.innerHTML =
          `<div class="songTitle">${esc(s.title)}</div>
           <div class="songMeta">
             <span class="pill">👤 ${esc(s.artist || "—")}</span>
             <span class="pill">🌍 ${esc(s.languageName || s.language || "—")}</span>
           </div>
           <div class="songSmall">${esc(s.short || "")}</div>`;
        list.appendChild(a);
      });
    }

    if (langSel) langSel.addEventListener("change", render);
    if (search) search.addEventListener("input", render);
    render();
  }

  /* ── boot ── */
  window.addEventListener("DOMContentLoaded", () => {
    showStorageConsent();
    bootSongPage();
    bootHome();
  });
})();
