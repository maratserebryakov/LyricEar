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
        tx.objectStore(IDB_STORE).put(
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
        const req = tx.objectStore(IDB_STORE).get(songId);
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
        tx.objectStore(IDB_STORE).delete(songId);
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
  function createSpectrogram(canvas, playerEl) {
    const ctx = canvas.getContext("2d");
    let audioCtx = null;
    let analyser = null;
    let source = null;
    let connected = false;
    let rafId = null;
    let running = false;

    /* palette: logo-inspired purple gradient */
    const STOPS = [
      [0.00,  10,   8,  28],
      [0.15,  30,  15,  70],
      [0.30,  70,  20, 120],
      [0.50, 140,  40, 170],
      [0.70, 200,  60, 180],
      [0.85, 240, 120, 200],
      [1.00, 255, 220, 255]
    ];
    const LUT = new Array(256);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lo = 0, hi = STOPS.length - 1;
      for (let s = 0; s < STOPS.length - 1; s++) {
        if (t >= STOPS[s][0] && t <= STOPS[s + 1][0]) { lo = s; hi = s + 1; break; }
      }
      const range = STOPS[hi][0] - STOPS[lo][0] || 1;
      const f = (t - STOPS[lo][0]) / range;
      LUT[i] = [
        Math.round(STOPS[lo][1] + (STOPS[hi][1] - STOPS[lo][1]) * f),
        Math.round(STOPS[lo][2] + (STOPS[hi][2] - STOPS[lo][2]) * f),
        Math.round(STOPS[lo][3] + (STOPS[hi][3] - STOPS[lo][3]) * f)
      ];
    }

    let zoom = 1;
    let writeX = 0;
    let freqData = null;

    function ensureAudio() {
      if (connected) return true;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        analyser.minDecibels = -100;
        analyser.maxDecibels = -20;
        source = audioCtx.createMediaElementSource(playerEl);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        connected = true;
        return true;
      } catch (e) {
        console.warn("[Spectrogram] Web Audio init failed:", e);
        return false;
      }
    }

    function resetCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bg = LUT[0];
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      writeX = 0;
    }

    function drawColumn() {
      if (!analyser || !freqData) return;
      analyser.getByteFrequencyData(freqData);
      const W = canvas.width;
      const H = canvas.height;

      if (writeX >= W) {
        const img = ctx.getImageData(1, 0, W - 1, H);
        ctx.putImageData(img, 0, 0);
        writeX = W - 1;
      }

      const totalBins = analyser.frequencyBinCount;
      const visBins = Math.floor(totalBins / zoom);

      const col = ctx.createImageData(1, H);
      const d = col.data;
      for (let y = 0; y < H; y++) {
        const bin = Math.floor((1 - y / H) * visBins);
        const val = Math.max(0, Math.min(255, freqData[bin] || 0));
        const c = LUT[val];
        const off = y * 4;
        d[off]     = c[0];
        d[off + 1] = c[1];
        d[off + 2] = c[2];
        d[off + 3] = 255;
      }
      ctx.putImageData(col, writeX, 0);
      writeX++;
    }

    function loop() {
      if (!running) return;
      drawColumn();
      rafId = requestAnimationFrame(loop);
    }

    function start()   { if (!ensureAudio()) return; if (audioCtx.state === "suspended") audioCtx.resume(); running = true; loop(); }
    function stop()    { running = false; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    function clear()   { stop(); resetCanvas(); }
    function zoomIn()  { if (zoom < 4) { zoom *= 2; clear(); } }
    function zoomOut() { if (zoom > 1) { zoom /= 2; clear(); } }
    function getZoom() { return zoom; }

    let resizeT = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => { if (canvas.offsetParent !== null) resetCanvas(); }, 200);
    });

    resetCanvas();
    return { start, stop, clear, zoomIn, zoomOut, getZoom, ensureAudio, resetCanvas };
  }

  /* ── storage consent ── */
  function showStorageConsent() {
    const KEY = "lyricear_storage_ok";
    if (localStorage.getItem(KEY)) return;
    const bar = document.createElement("div");
    bar.id = "storageBanner";
    bar.innerHTML =
      `<span>Этот сайт сохраняет прогресс и медиа в браузере. Данные не передаются на сервер.</span>
       <button id="storageOk">Понятно</button>`;
    document.body.appendChild(bar);
    $("#storageOk").addEventListener("click", () => { localStorage.setItem(KEY, "1"); bar.remove(); });
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
      it.start   = l.start ?? it.start ?? null;
      it.end     = l.end   ?? it.end   ?? null;
      it.learned = typeof l.learned === "boolean" ? l.learned : it.learned;
      if (l.phonetic_user) it.phonetic_user = l.phonetic_user;
    });
    return out;
  }

  function getSongSlug() {
    return new URLSearchParams(location.search).get("song")
      || document.documentElement.dataset.songJson
      || null;
  }

  function slugToUrl(slug) {
    return slug.includes("/") ? slug : `data/songs/${slug}.json`;
  }

  /* ══════════════════════════════════════
     SONG PAGE
     ══════════════════════════════════════ */
  async function bootSongPage() {
    const slug = getSongSlug();
    if (!slug) return;

    const JSON_URL = slugToUrl(slug);
    const PREFIX = "lyricear_v1::";

    let state;
    try {
      const remote = await fetchJson(JSON_URL);
      const key = PREFIX + (remote.song?.id || slug);
      const raw = localStorage.getItem(key);
      const local = raw ? JSON.parse(raw) : null;
      state = local ? mergeProgress(remote, local) : remote;
      state._storageKey = key;
    } catch (e) {
      toast("Не удалось загрузить песню", String(e));
      return;
    }
    normalizeState(state);
    const songId = state.song?.id || slug;
    if (state.song?.title) document.title = `${state.song.title} — LyricEar`;

    /* DOM */
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
    const linesHost       = $("#lines");
    const saveIndicator   = $("#saveIndicator");

    /* spectrogram DOM */
    const specCanvas  = $("#spectrogramCanvas");
    const specWrap    = $("#spectrogramWrap");
    const specToggle  = $("#spectrogramToggle");
    const specZoomIn  = $("#specZoomIn");
    const specZoomOut = $("#specZoomOut");
    const specZoomLbl = $("#specZoomLabel");

    let spec = null;
    let activeIndex = 0;
    let loopTimer = null;

    /* header */
    function applyHeader() {
      const t = $("#songTitle");  if (t) t.textContent = state.song?.title || "—";
      const a = $("#songArtist"); if (a) a.textContent = state.song?.artist || "—";
      const l = $("#songLang");   if (l) l.textContent = state.song?.languageName || state.song?.language || "—";
      const h = $("#songHint");   if (h) h.textContent = state.song?.hint || "";
    }
    applyHeader();

    /* lamp */
    function setLamp(src) {
      if (!lamp) return;
      lamp.className = "lamp";
      if (src === "local" || src === "cached") { lamp.classList.add("lamp-green"); }
      else if (src === "remote") { lamp.classList.add("lamp-red"); }
      else { lamp.classList.add("lamp-off"); }
    }
    setLamp("none");

    function showMediaN(n) { if (mediaName) { mediaName.textContent = n || ""; mediaName.style.display = n ? "inline" : "none"; } }
    showMediaN("");

    function showForgetBtn(v) { if (btnForgetMedia) btnForgetMedia.style.display = v ? "inline-block" : "none"; }
    showForgetBtn(false);

    /* save */
    let saveT = null;
    function save() {
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        try { localStorage.setItem(state._storageKey, JSON.stringify(state)); } catch {}
        if (saveIndicator) { saveIndicator.classList.add("flash"); setTimeout(() => saveIndicator.classList.remove("flash"), 600); }
      }, 300);
    }

    /* media type */
    const VID_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ogv)$/i;
    function isVideo(name, mime) {
      if (mime && mime.startsWith("video/")) return true;
      if (VID_RE.test(name)) return true;
      return false;
    }
    function applyMode(v) {
      player.classList.toggle("is-video", v);
      player.classList.toggle("is-audio", !v);
    }
    applyMode(false);

    /* load blob */
    async function loadBlob(blob, name, mime, src, persist) {
      if (player._url) try { URL.revokeObjectURL(player._url); } catch {}
      const url = URL.createObjectURL(blob);
      player._url = url;
      applyMode(isVideo(name, mime));
      player.src = url;
      player.load();
      setLamp(src);
      showMediaN(name);
      showForgetBtn(true);
      if (btnLoadLocal) btnLoadLocal.classList.remove("pulse");

      /* init spectrogram after media element has src */
      if (specCanvas && !spec) {
        spec = createSpectrogram(specCanvas, player);
      }

      if (persist) {
        const ok = await idbSave(songId, blob, name, mime);
        toast(ok ? "💾 Файл сохранён в кэш" : "▶ Файл открыт", name);
      }
    }

    /* restore from IDB */
    async function tryRestore() {
      const c = await idbLoad(songId);
      if (!c || !c.blob) return false;
      await loadBlob(c.blob, c.name, c.type, "cached", false);
      toast("📦 Медиа из кэша", c.name);
      return true;
    }

    /* local file */
    if (btnLoadLocal && mediaPick) {
      btnLoadLocal.addEventListener("click", () => mediaPick.click());
      mediaPick.addEventListener("change", () => {
        const f = mediaPick.files?.[0];
        if (f) loadBlob(f, f.name, f.type, "local", true);
      });
    }

    /* forget */
    if (btnForgetMedia) {
      btnForgetMedia.addEventListener("click", async () => {
        if (!confirm("Удалить медиа из кэша?")) return;
        await idbDelete(songId);
        if (player._url) try { URL.revokeObjectURL(player._url); } catch {}
        player.removeAttribute("src"); player.load();
        applyMode(false); setLamp("none"); showMediaN(""); showForgetBtn(false);
        if (spec) { spec.clear(); spec = null; }
        toast("🗑 Медиа удалено");
      });
    }

    /* YaDisk */
    if (btnLoadYaDisk) {
      const yd = state.song?.media?.yadisk;
      if (!yd) { btnLoadYaDisk.style.display = "none"; }
      else {
        btnLoadYaDisk.addEventListener("click", () => {
          window.open(yd, "yadisk", "width=700,height=500");
          if (btnLoadLocal) btnLoadLocal.classList.add("pulse");
          toast("📥 Скачайте и откройте через «📁 Выбрать файл»");
        });
      }
    }

    /* player events */
        /* ── custom play/pause button ── */
    const btnPlay = $("#btnPlay");
    const playProgress = $("#playProgress");
    const playTime = $("#playTime");

    function fmtTime(t) {
      if (!Number.isFinite(t)) return "0:00";
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return m + ":" + String(s).padStart(2, "0");
    }

    if (btnPlay) {
      btnPlay.addEventListener("click", () => {
        if (!player.src && !player.currentSrc) { toast("Сначала выберите файл"); return; }
        if (player.paused) player.play().catch(() => {});
        else player.pause();
      });
    }
    player.addEventListener("play",  () => { if (btnPlay) btnPlay.textContent = "⏸"; });
    player.addEventListener("pause", () => { if (btnPlay) btnPlay.textContent = "▶"; });
    player.addEventListener("ended", () => { if (btnPlay) btnPlay.textContent = "▶"; });

    if (playProgress) {
      player.addEventListener("timeupdate", () => {
        if (player.duration) playProgress.value = (player.currentTime / player.duration * 1000).toFixed(0);
        if (playTime) playTime.textContent = fmtTime(player.currentTime) + " / " + fmtTime(player.duration);
      });
      playProgress.addEventListener("input", () => {
        if (player.duration) player.currentTime = (playProgress.value / 1000) * player.duration;
      });
    }
    player.addEventListener("timeupdate", () => { if (elNow) elNow.textContent = (player.currentTime || 0).toFixed(2) + "s"; });
    player.addEventListener("loadedmetadata", () => { if (btnStart) btnStart.disabled = false; if (btnEnd) btnEnd.disabled = false; renderSegStatus(); });
    player.addEventListener("loadeddata", () => { if (btnLoadLocal) btnLoadLocal.classList.remove("pulse"); if (player.videoHeight > 0) applyMode(true); });
    player.addEventListener("error", () => { toast("Ошибка медиа"); setLamp("none"); });

    /* spectrogram ↔ player */
    player.addEventListener("play", () => {
      if (spec) { spec.ensureAudio(); spec.clear(); spec.start(); }
    });
    player.addEventListener("pause", () => { if (spec) spec.stop(); });
    player.addEventListener("ended", () => { if (spec) spec.stop(); });
    player.addEventListener("seeked", () => { if (spec && !player.paused) spec.clear(); });

    /* spectrogram UI */
    if (specToggle && specWrap) {
      specToggle.addEventListener("click", () => {
        const c = specWrap.classList.toggle("collapsed");
        specToggle.textContent = c ? "📊 Спектрограмма ▸" : "📊 Спектрограмма ▾";
        if (!c && spec) spec.resetCanvas();
      });
    }
    function updateZL() { if (specZoomLbl && spec) specZoomLbl.textContent = `×${spec.getZoom()}`; }
    if (specZoomIn)  specZoomIn.addEventListener("click",  () => { if (spec) { spec.zoomIn();  updateZL(); } });
    if (specZoomOut) specZoomOut.addEventListener("click", () => { if (spec) { spec.zoomOut(); updateZL(); } });

    /* ── segment controls ── */
    function renderSegStatus() {
      const el = $("#segStatus"); if (!el) return;
      const it = state.items[activeIndex];
      const s = it?.start, e = it?.end;
      el.innerHTML =
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

    function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }

    function playSegment() {
      const it = state.items[activeIndex];
      const s = it?.start, e = it?.end;
      if (!(s != null && e != null && Number(e) > Number(s))) { toast("Нужны Start и End"); return; }
      stopLoop();
      player.currentTime = Number(s);
      player.play().catch(() => {});
      loopTimer = setInterval(() => {
        if (!player || player.paused) return;
        if (player.currentTime >= Number(e) - 0.03) {
          if (loopToggle?.checked) {
            player.currentTime = Number(s);
            if (spec) spec.clear();
          } else {
            stopLoop(); player.pause();
            if (autoNextToggle?.checked) {
              const nx = Math.min(activeIndex + 1, state.items.length - 1);
              if (nx !== activeIndex) {
                setActive(nx, true);
                const ni = state.items[nx];
                if (ni?.start != null && ni?.end != null && Number(ni.end) > Number(ni.start))
                  setTimeout(playSegment, 120);
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
      if (it.start != null && Number(it.end) <= Number(it.start)) { toast("End ≤ Start"); it.end = null; }
      save(); renderLines();
    });
    if (btnClear) btnClear.addEventListener("click", () => {
      const it = state.items[activeIndex];
      it.start = null; it.end = null;
      save(); renderLines();
    });

    /* active line */
    function setActive(idx, seek) {
      activeIndex = Math.max(0, Math.min(idx, state.items.length - 1));
      renderLines();
      const it = state.items[activeIndex];
      if (seek && it?.start != null && Number.isFinite(it.start))
        player.currentTime = Math.max(0, Number(it.start));
    }

    /* render lines */
    function renderLines() {
      const sO = globalShowOrig?.checked  || false;
      const sT = globalShowTrans?.checked || false;
      const sP = globalShowPhon?.checked  || false;
      const sW = globalShowWhy?.checked   || false;
      state.ui.showOriginalByDefault    = sO;
      state.ui.showTranslationByDefault = sT;
      state.ui.showPhoneticByDefault    = sP;
      state.ui.showWhyHeardByDefault    = sW;

      linesHost.innerHTML = "";

      state.items.forEach((it, idx) => {
        const isAct = idx === activeIndex;
        const hasT = it.start != null && it.end != null && Number(it.end) > Number(it.start);

        const line = document.createElement("div");
        line.className = "line" + (isAct ? " active" : "") + (it.learned ? " learned" : "");

        /* header: number + input */
        const hdr = document.createElement("div"); hdr.className = "line-header";
        const num = document.createElement("span"); num.className = "line-num"; num.textContent = idx + 1;
        const inp = document.createElement("input");
        inp.type = "text"; inp.className = "user-heard"; inp.placeholder = "Как услышал(а)…";
        inp.value = it.phonetic_user || "";
        inp.addEventListener("input", () => { it.phonetic_user = inp.value; save(); });
        inp.addEventListener("click", e => e.stopPropagation());
        hdr.appendChild(num); hdr.appendChild(inp);

        /* orig row */
        const origRow = document.createElement("div"); origRow.className = "orig-row";
        let revealed = sO;
        const origTxt = document.createElement("span"); origTxt.className = "orig-text";
        origTxt.textContent = it.text || "—"; origTxt.style.display = revealed ? "inline" : "none";
        const btnR = document.createElement("button"); btnR.className = "tiny btn-reveal";
        btnR.textContent = revealed ? "👁 Скрыть" : "👁 Показать";
        btnR.addEventListener("click", e => {
          e.stopPropagation(); revealed = !revealed;
          origTxt.style.display = revealed ? "inline" : "none";
          btnR.textContent = revealed ? "👁 Скрыть" : "👁 Показать";
        });
        origRow.appendChild(btnR); origRow.appendChild(origTxt);

        /* sub rows */
        const phonRow  = document.createElement("div"); phonRow.className  = "sub sub-phon"  + (sP ? " visible" : "");
        if (it.phonetic) phonRow.innerHTML = `<div class="subCard"><b>👂</b> <span class="mono phon-author">${esc(it.phonetic)}</span></div>`;

        const transRow = document.createElement("div"); transRow.className = "sub sub-trans" + (sT ? " visible" : "");
        if (it.translation) transRow.innerHTML = `<div class="subCard"><span class="muted">Перевод:</span> ${esc(it.translation)}</div>`;

        const whyRow   = document.createElement("div"); whyRow.className   = "sub sub-why"   + (sW ? " visible" : "");
        if (it.why) {
          const conf = typeof it.confidence === "number" ? ` <span class="pill">≈${(clamp01(it.confidence)*100).toFixed(0)}%</span>` : "";
          whyRow.innerHTML = `<div class="subCard"><b>🧠</b>${conf}<div style="margin-top:4px">${esc(it.why)}</div></div>`;
        }

        /* actions */
        const acts = document.createElement("div"); acts.className = "line-actions";
        function mb(t, c, fn) { const b = document.createElement("button"); b.className = c; b.textContent = t; b.addEventListener("click", e => { e.stopPropagation(); fn(); }); return b; }
        acts.appendChild(mb("Выбрать", "tiny btn-primary", () => setActive(idx, true)));
        if (hasT) acts.appendChild(mb("▶", "tiny", () => { setActive(idx, false); playSegment(); }));
        if (it.phonetic) acts.appendChild(mb("👂", "tiny", () => phonRow.classList.toggle("visible")));
        acts.appendChild(mb("💬", "tiny", () => transRow.classList.toggle("visible")));
        if (it.why) acts.appendChild(mb("🧠", "tiny", () => whyRow.classList.toggle("visible")));
        acts.appendChild(mb(it.learned ? "✓ Выучено" : "Выучено", "tiny " + (it.learned ? "btn-good" : ""), () => { it.learned = !it.learned; save(); renderLines(); }));

        line.appendChild(hdr);
        line.appendChild(origRow);
        line.appendChild(phonRow);
        line.appendChild(transRow);
        line.appendChild(whyRow);
        line.appendChild(acts);
        line.addEventListener("click", () => setActive(idx, true));
        linesHost.appendChild(line);
      });

      renderSegStatus();
      save();
    }

    /* reset */
    const btnReset = $("#btnResetProgress");
    if (btnReset) {
      btnReset.addEventListener("click", async () => {
        if (!confirm("Сбросить прогресс?")) return;
        try {
          const r = await fetchJson(JSON_URL);
          const k = state._storageKey;
          state = r; state._storageKey = k;
          normalizeState(state); save(); applyHeader(); setActive(0, false);
          toast("✅ Прогресс сброшен");
        } catch (e) { toast("Ошибка", String(e)); }
      });
    }

    /* toggles */
    if (globalShowOrig)  globalShowOrig.checked  = !!state.ui.showOriginalByDefault;
    if (globalShowTrans) globalShowTrans.checked = !!state.ui.showTranslationByDefault;
    if (globalShowPhon)  globalShowPhon.checked  = !!state.ui.showPhoneticByDefault;
    if (globalShowWhy)   globalShowWhy.checked   = !!state.ui.showWhyHeardByDefault;
    [globalShowOrig, globalShowTrans, globalShowPhon, globalShowWhy].forEach(el => {
      if (el) el.addEventListener("change", renderLines);
    });

    /* start */
    renderLines();
    setActive(0, false);

    /* restore media */
    tryRestore().then(ok => {
      if (!ok && btnLoadLocal) btnLoadLocal.classList.add("pulse");
    });

    /* keyboard */
    document.addEventListener("keydown", e => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); player.paused ? player.play().catch(()=>{}) : player.pause(); }
      if (k === "s") { e.preventDefault(); if (btnStart) btnStart.click(); }
      if (k === "e") { e.preventDefault(); if (btnEnd) btnEnd.click(); const nx = Math.min(activeIndex+1, state.items.length-1); if (nx !== activeIndex) setTimeout(() => setActive(nx, false), 100); }
      if (k === "arrowdown" || k === "n") { e.preventDefault(); setActive(Math.min(activeIndex+1, state.items.length-1), false); }
      if (k === "arrowup"   || k === "p") { e.preventDefault(); setActive(Math.max(activeIndex-1, 0), false); }
      if (k === "r") { e.preventDefault(); playSegment(); }
    });

    toast("⌨ S/E=метки, Space=play, ↑↓=строки, R=фрагмент");
  }

  /* ══════════════════════════════════════
     HOME PAGE
     ══════════════════════════════════════ */
  async function bootHome() {
    const root = document.documentElement;
    if (!root.dataset.catalog) return;
    const list = $("#songsList"), langSel = $("#langFilter"), search = $("#q");
    let catalog;
    try { catalog = await fetchJson(root.dataset.catalog); } catch (e) { toast("Каталог не загружен", String(e)); return; }
    const songs = catalog.songs || [], langs = catalog.languages || [];
    if (langSel) {
      langSel.innerHTML = `<option value="">Все языки</option>` +
        langs.map(l => `<option value="${esc(l.code)}">${esc(l.name)}</option>`).join("");
    }
    function render() {
      const q = (search?.value || "").trim().toLowerCase();
      const lang = langSel?.value || "";
      const f = songs.filter(s => {
        const okL = !lang || s.language === lang;
        const hay = `${s.title} ${s.artist} ${s.languageName || ""}`.toLowerCase();
        return okL && (!q || hay.includes(q));
      });
      const c = $("#count"); if (c) c.textContent = f.length;
      if (!list) return;
      list.innerHTML = "";
      f.forEach(s => {
        const a = document.createElement("a"); a.className = "songCard"; a.href = s.url;
        a.innerHTML = `<div class="songTitle">${esc(s.title)}</div><div class="songMeta"><span class="pill">👤 ${esc(s.artist||"—")}</span><span class="pill">🌍 ${esc(s.languageName||s.language||"—")}</span></div><div class="songSmall">${esc(s.short||"")}</div>`;
        list.appendChild(a);
      });
    }
    if (langSel) langSel.addEventListener("change", render);
    if (search) search.addEventListener("input", render);
    render();
  }

  /* boot */
  window.addEventListener("DOMContentLoaded", () => {
    showStorageConsent();
    bootSongPage();
    bootHome();
  });
})();
