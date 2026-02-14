;;(function () {
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
        if (!db.objectStoreNames.contains(IDB_STORE))
          db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
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
        tx.onerror    = () => { db.close(); reject(tx.error); };
      });
    } catch (e) { console.warn("[IDB] save failed:", e); return false; }
  }

  async function idbLoad(songId) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx  = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(songId);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror   = () => { db.close(); reject(req.error); };
      });
    } catch (e) { console.warn("[IDB] load failed:", e); return null; }
  }

  async function idbDelete(songId) {
    try {
      const db = await idbOpen();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(songId);
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror    = () => { db.close(); reject(tx.error); };
      });
    } catch (e) { console.warn("[IDB] delete failed:", e); return false; }
  }

  /* ══════════════════════════════════════
     Spectrogram Engine
     ══════════════════════════════════════ */
      function createSpectrogram(canvas, playerEl) {
    const ctx = canvas.getContext("2d");
    let audioCtx = null, analyser = null, source = null;
    let connected = false, rafId = null, running = false;

    // ── LUT: чёрный → фиолет → розовый → голубой → лазурный ──
    const STOPS = [
      [0.00,   4,   2,  12],
      [0.10,  25,  10,  55],
      [0.20,  60,  18, 115],
      [0.32, 110,  28, 165],
      [0.45, 170,  40, 185],
      [0.58, 215,  60, 195],
      [0.70, 195,  95, 238],
      [0.82, 110, 175, 248],
      [0.92,  55, 228, 255],
      [1.00, 230, 253, 255]
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

    let zoom = 1, writeX = 0, freqData = null;

    // Noise floor: auto-adapts to the signal
    let noiseFloor = 5;
    let peakVal = 80;

    const FREQ_ZONES = [
      { freq: 300,  label: "300 Hz",  desc: "гласные",    color: "rgba(55,230,255,0.9)" },
      { freq: 3000, label: "3 kHz",   desc: "согласные",   color: "rgba(215,60,195,0.9)" },
      { freq: 6000, label: "6 kHz",   desc: "шипящие",     color: "rgba(155,95,238,0.8)" },
    ];

    const ZONE_BANDS = [
      { from: 0,    to: 300,   bg: "rgba(55,230,255,0.06)" },
      { from: 300,  to: 3000,  bg: "rgba(215,60,195,0.05)" },
      { from: 3000, to: 24000, bg: "rgba(155,95,238,0.04)" },
    ];

    function getMaxFreq() {
      return audioCtx ? audioCtx.sampleRate / 2 : 22050;
    }

    function freqToY(freq, H) {
      const mf = getMaxFreq() / zoom;
      const r = freq / mf;
      return r > 1 ? -1 : Math.round(H * (1 - r));
    }

    function drawZones() {
      const W = canvas.width, H = canvas.height;
      const mf = getMaxFreq() / zoom;
      const dpr = window.devicePixelRatio || 1;

      ZONE_BANDS.forEach(b => {
        if (b.from >= mf) return;
        const y1 = Math.max(0, freqToY(Math.min(b.to, mf), H));
        const y2 = Math.min(H, freqToY(b.from, H));
        ctx.fillStyle = b.bg;
        ctx.fillRect(0, y1, W, y2 - y1);
      });

      const fs = Math.round(10 * dpr);
      ctx.font = `bold ${fs}px -apple-system,BlinkMacSystemFont,sans-serif`;
      ctx.textBaseline = "bottom";

      FREQ_ZONES.forEach(z => {
        if (z.freq >= mf) return;
        const y = freqToY(z.freq, H);
        if (y < 0 || y > H) return;

        ctx.strokeStyle = z.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.setLineDash([]);

        const txt = `${z.label}  ${z.desc}`;
        const tw = ctx.measureText(txt).width;
        const p = 3 * dpr;

        ctx.fillStyle = "rgba(0,0,0,0.75)";
        const bx = 3 * dpr, by = y - fs - p * 2, bw = tw + p * 2, bh = fs + p * 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 3 * dpr);
        else ctx.rect(bx, by, bw, bh);
        ctx.fill();

        ctx.fillStyle = z.color;
        ctx.fillText(txt, bx + p, y - p);
      });
    }

    function ensureAudio() {
      if (connected) return true;
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.3;
        analyser.minDecibels = -100;
        analyser.maxDecibels = -10;
        source = audioCtx.createMediaElementSource(playerEl);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        connected = true;
        return true;
      } catch (e) { console.warn("[Spec]", e); return false; }
    }

    function resetCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width  = Math.round(r.width  * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgb(${LUT[0][0]},${LUT[0][1]},${LUT[0][2]})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      writeX = 0;
      noiseFloor = 5; peakVal = 80;
      drawZones();
    }

    function drawColumn() {
      if (!analyser || !freqData) return;
      analyser.getByteFrequencyData(freqData);

      const W = canvas.width, H = canvas.height;
      if (writeX >= W) {
        const img = ctx.getImageData(1, 0, W - 1, H);
        ctx.putImageData(img, 0, 0);
        writeX = W - 1;
      }

      const totalBins = analyser.frequencyBinCount;
      const visBins = Math.floor(totalBins / zoom);

      // ── auto-range: find current frame min/max ──
      let frameMin = 255, frameMax = 0;
      for (let b = 0; b < visBins; b++) {
        const v = freqData[b];
        if (v < frameMin) frameMin = v;
        if (v > frameMax) frameMax = v;
      }
      // smooth adaptation
      noiseFloor += (frameMin - noiseFloor) * 0.05;
      peakVal    += (Math.max(frameMax, noiseFloor + 20) - peakVal) * 0.08;
      const floor = Math.max(0, noiseFloor - 2);
      const range = Math.max(30, peakVal - floor);

      const col = ctx.createImageData(1, H);
      const d = col.data;

      for (let y = 0; y < H; y++) {
        const bin = Math.floor((1 - y / H) * visBins);
        const raw = freqData[bin] || 0;

        // normalize to 0..1 using adaptive range
        let norm = (raw - floor) / range;
        norm = Math.max(0, Math.min(1, norm));

        // apply gamma curve for better contrast (lift quiet parts)
        norm = Math.pow(norm, 0.6);

        const idx = Math.round(norm * 255);
        const c = LUT[idx];
        const off = y * 4;
        d[off] = c[0]; d[off+1] = c[1]; d[off+2] = c[2]; d[off+3] = 255;
      }

      ctx.putImageData(col, writeX, 0);
      writeX++;
      drawZones();
    }

    function loop() { if (!running) return; drawColumn(); rafId = requestAnimationFrame(loop); }

    function start() {
      if (!ensureAudio()) return;
      if (audioCtx.state === "suspended") audioCtx.resume();
      if (running) return;
      running = true; loop();
    }
    function stop()    { running = false; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
    function clear()   { resetCanvas(); }
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
      if (!("start" in it))    it.start = null;
      if (!("end" in it))      it.end   = null;
      if (typeof it.learned    !== "boolean") it.learned = false;
      if (typeof it.confidence !== "number")  it.confidence = null;
      if (typeof it.phonetic_user !== "string") it.phonetic_user = "";
    });
  }

  function mergeProgress(remote, local) {
    const out = structuredClone(remote);
    if (local?.ui) out.ui = Object.assign({}, out.ui || {}, local.ui);
    const m = new Map((local.items || []).map(x => [x.id, x]));
    (out.items || []).forEach(it => {
      const l = m.get(it.id); if (!l) return;
      it.start   = l.start ?? it.start ?? null;
      it.end     = l.end   ?? it.end   ?? null;
      it.learned = typeof l.learned === "boolean" ? l.learned : it.learned;
      if (l.phonetic_user) it.phonetic_user = l.phonetic_user;
    });
    return out;
  }

  function getSongSlug() {
    return new URLSearchParams(location.search).get("song")
      || document.documentElement.dataset.songJson || null;
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
    const PREFIX   = "lyricear_v1::";

    let state;
    try {
      const remote = await fetchJson(JSON_URL);
      const key    = PREFIX + (remote.song?.id || slug);
      const raw    = localStorage.getItem(key);
      const local  = raw ? JSON.parse(raw) : null;
      state = local ? mergeProgress(remote, local) : remote;
      state._storageKey = key;
    } catch (e) { toast("Не удалось загрузить песню", String(e)); return; }
    normalizeState(state);
    const songId = state.song?.id || slug;
    if (state.song?.title) document.title = `${state.song.title} — LyricEar`;

    /* ── DOM refs ── */
    const player         = $("#player");
    const videoWrap      = $("#videoWrap");
    const mediaPick      = $("#mediaPick");
    const btnLoadLocal   = $("#btnLoadLocal");
    const btnLoadYaDisk  = $("#btnLoadYaDisk");
    const btnForgetMedia = $("#btnForgetMedia");
    const mediaName      = $("#mediaName");
    const lamp           = $("#mediaLamp");
    const elNow          = $("#tNow");
    const btnPlay        = $("#btnPlay");
    const playProgress   = $("#playProgress");
    const playTime       = $("#playTime");
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

    const specCanvas  = $("#spectrogramCanvas");
    const specWrap    = $("#spectrogramWrap");
    const specToggle  = $("#spectrogramToggle");
    const specZoomIn  = $("#specZoomIn");
    const specZoomOut = $("#specZoomOut");
    const specZoomLbl = $("#specZoomLabel");

    let spec = null;
    let activeIndex = 0;
    let loopTimer   = null;

    /* header */
    function applyHeader() {
      const t = $("#songTitle");  if (t) t.textContent = state.song?.title  || "—";
      const a = $("#songArtist"); if (a) a.textContent = state.song?.artist || "—";
      const l = $("#songLang");   if (l) l.textContent = state.song?.languageName || state.song?.language || "—";
      const h = $("#songHint");   if (h) h.textContent = state.song?.hint   || "";
    }
    applyHeader();

    /* lamp */
    function setLamp(src) {
      if (!lamp) return;
      lamp.className = "lamp";
      if (src === "local" || src === "cached") lamp.classList.add("lamp-green");
      else if (src === "remote")               lamp.classList.add("lamp-red");
      else                                     lamp.classList.add("lamp-off");
    }
    setLamp("none");

    function showMediaN(n) {
      if (mediaName) { mediaName.textContent = n || ""; mediaName.style.display = n ? "inline" : "none"; }
    }
    showMediaN("");

    function showForgetBtn(v) {
      if (btnForgetMedia) btnForgetMedia.style.display = v ? "inline-block" : "none";
    }
    showForgetBtn(false);

    /* save */
    let saveT = null;
    function save() {
      clearTimeout(saveT);
      saveT = setTimeout(() => {
        try { localStorage.setItem(state._storageKey, JSON.stringify(state)); } catch {}
        if (saveIndicator) {
          saveIndicator.classList.add("flash");
          setTimeout(() => saveIndicator.classList.remove("flash"), 600);
        }
      }, 300);
    }

    /* media type */
    const VID_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ogv)$/i;
    function isVideo(name, mime) {
      if (mime && mime.startsWith("video/")) return true;
      return VID_RE.test(name);
    }
    function applyMode(v) {
      if (videoWrap) {
        videoWrap.classList.toggle("is-video", v);
        videoWrap.classList.toggle("is-audio", !v);
      }
    }
    applyMode(false);

    /* ── Spectrogram helpers ── */
    function ensureSpec() {
      if (!spec && specCanvas) {
        spec = createSpectrogram(specCanvas, player);
      }
    }
    function specStart() {
      ensureSpec();
      if (spec) { spec.ensureAudio(); spec.start(); }
    }
    function specStop()  { if (spec) spec.stop(); }
    function specClear() { if (spec) spec.clear(); }

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
      ensureSpec();
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
        if (spec) { spec.stop(); spec.clear(); }
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

    /* ── play / pause ── */
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
    player.addEventListener("play",  () => { if (btnPlay) btnPlay.textContent = "⏸"; specStart(); });
    player.addEventListener("pause", () => { if (btnPlay) btnPlay.textContent = "▶";  specStop(); });
    player.addEventListener("ended", () => { if (btnPlay) btnPlay.textContent = "▶";  specStop(); });
    player.addEventListener("seeked", () => { if (!player.paused) specClear(); });

    /* progress bar & time */
    player.addEventListener("timeupdate", () => {
      if (elNow) elNow.textContent = (player.currentTime || 0).toFixed(2) + "s";
      if (playProgress && player.duration)
        playProgress.value = (player.currentTime / player.duration * 1000).toFixed(0);
      if (playTime)
        playTime.textContent = fmtTime(player.currentTime) + " / " + fmtTime(player.duration);
    });
    if (playProgress) {
      playProgress.addEventListener("input", () => {
        if (player.duration) player.currentTime = (playProgress.value / 1000) * player.duration;
      });
    }

    player.addEventListener("loadedmetadata", () => {
      if (btnStart) btnStart.disabled = false;
      if (btnEnd)   btnEnd.disabled   = false;
      renderSegStatus();
    });
    player.addEventListener("loadeddata", () => {
      if (btnLoadLocal) btnLoadLocal.classList.remove("pulse");
      if (player.videoHeight > 0) applyMode(true);
    });
    player.addEventListener("error", () => { toast("Ошибка медиа"); setLamp("none"); });

    /* spectrogram UI */
    if (specToggle && specWrap) {
      specToggle.addEventListener("click", () => {
        const c = specWrap.classList.toggle("collapsed");
        specToggle.textContent = c ? "📊 Спектрограмма ▸" : "📊 Спектрограмма ▾";
        if (!c) {
          setTimeout(() => {
            if (spec) spec.resetCanvas();
            if (spec && !player.paused) {
              spec.ensureAudio();
              spec.start();
            }
          }, 300);
        } else {
          if (spec) spec.stop();
        }
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
      specClear();
      player.play().catch(() => {});

      loopTimer = setInterval(() => {
        if (!player || player.paused) return;
        if (player.currentTime >= Number(e) - 0.03) {
          if (loopToggle?.checked) {
            player.currentTime = Number(s);
            specClear();
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
        const hasT  = it.start != null && it.end != null && Number(it.end) > Number(it.start);

        const line = document.createElement("div");
        line.className = "line" + (isAct ? " active" : "") + (it.learned ? " learned" : "");

        const hdr = document.createElement("div"); hdr.className = "line-header";
        const num = document.createElement("span"); num.className = "line-num"; num.textContent = idx + 1;
        const inp = document.createElement("input");
        inp.type = "text"; inp.className = "user-heard"; inp.placeholder = "Как услышал(а)…";
        inp.value = it.phonetic_user || "";
        inp.addEventListener("input", () => { it.phonetic_user = inp.value; save(); });
        inp.addEventListener("click", e => e.stopPropagation());
        hdr.appendChild(num); hdr.appendChild(inp);

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

        const phonRow  = document.createElement("div");
        phonRow.className = "sub sub-phon" + (sP ? " visible" : "");
        if (it.phonetic) phonRow.innerHTML = `<div class="subCard"><b>👂</b> <span class="mono phon-author">${esc(it.phonetic)}</span></div>`;

        const transRow = document.createElement("div");
        transRow.className = "sub sub-trans" + (sT ? " visible" : "");
        if (it.translation) transRow.innerHTML = `<div class="subCard"><span class="muted">Перевод:</span> ${esc(it.translation)}</div>`;

        const whyRow = document.createElement("div");
        whyRow.className = "sub sub-why" + (sW ? " visible" : "");
        if (it.why) {
          const conf = typeof it.confidence === "number"
            ? ` <span class="pill">≈${(clamp01(it.confidence)*100).toFixed(0)}%</span>` : "";
          whyRow.innerHTML = `<div class="subCard"><b>🧠</b>${conf}<div style="margin-top:4px">${esc(it.why)}</div></div>`;
        }

        const acts = document.createElement("div"); acts.className = "line-actions";
        function mb(t, c, fn) {
          const b = document.createElement("button");
          b.className = c; b.textContent = t;
          b.addEventListener("click", e => { e.stopPropagation(); fn(); });
          return b;
        }
        acts.appendChild(mb("Выбрать", "tiny btn-primary", () => setActive(idx, true)));
        if (hasT) acts.appendChild(mb("▶", "tiny", () => { setActive(idx, false); playSegment(); }));
        if (it.phonetic) acts.appendChild(mb("👂", "tiny", () => phonRow.classList.toggle("visible")));
        acts.appendChild(mb("💬", "tiny", () => transRow.classList.toggle("visible")));
        if (it.why) acts.appendChild(mb("🧠", "tiny", () => whyRow.classList.toggle("visible")));
        acts.appendChild(mb(it.learned ? "✓ Выучено" : "Выучено",
          "tiny " + (it.learned ? "btn-good" : ""),
          () => { it.learned = !it.learned; save(); renderLines(); }));

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
      if (k === " ")  { e.preventDefault(); player.paused ? player.play().catch(()=>{}) : player.pause(); }
      if (k === "s")  { e.preventDefault(); if (btnStart) btnStart.click(); }
      if (k === "e")  { e.preventDefault(); if (btnEnd) btnEnd.click(); const nx = Math.min(activeIndex+1, state.items.length-1); if (nx !== activeIndex) setTimeout(() => setActive(nx, false), 100); }
      if (k === "arrowdown" || k === "n") { e.preventDefault(); setActive(Math.min(activeIndex+1, state.items.length-1), false); }
      if (k === "arrowup"   || k === "p") { e.preventDefault(); setActive(Math.max(activeIndex-1, 0), false); }
      if (k === "r")  { e.preventDefault(); playSegment(); }
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
      const q    = (search?.value || "").trim().toLowerCase();
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
        a.innerHTML =
          `<div class="songTitle">${esc(s.title)}</div>` +
          `<div class="songMeta"><span class="pill">👤 ${esc(s.artist||"—")}</span>` +
          `<span class="pill">🌍 ${esc(s.languageName||s.language||"—")}</span></div>` +
          `<div class="songSmall">${esc(s.short||"")}</div>`;
        list.appendChild(a);
      });
    }
    if (langSel) langSel.addEventListener("change", render);
    if (search)  search.addEventListener("input", render);
    render();
  }

  /* boot */
  window.addEventListener("DOMContentLoaded", async () => {
    showStorageConsent();
    try { await bootSongPage(); } catch(e) { console.error("bootSongPage error:", e); }
    try { await bootHome(); }     catch(e) { console.error("bootHome error:", e); }
  });
})();
