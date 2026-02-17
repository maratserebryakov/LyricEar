;(function () {
  /* helpers */
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
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  /* IndexedDB */
  var IDB_NAME = "lyricear-media";
  var IDB_STORE = "files";
  var IDB_VERSION = 1;

  function idbOpen() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = function() {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE))
          db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  }

  async function idbSave(songId, blob, fileName, mimeType) {
    try {
      var db = await idbOpen();
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(
          { blob: blob, name: fileName, type: mimeType, savedAt: Date.now() },
          songId
        );
        tx.oncomplete = function() { db.close(); resolve(true); };
        tx.onerror    = function() { db.close(); reject(tx.error); };
      });
    } catch (e) { console.warn("[IDB] save failed:", e); return false; }
  }

  async function idbLoad(songId) {
    try {
      var db = await idbOpen();
      return new Promise(function(resolve, reject) {
        var tx  = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(songId);
        req.onsuccess = function() { db.close(); resolve(req.result || null); };
        req.onerror   = function() { db.close(); reject(req.error); };
      });
    } catch (e) { console.warn("[IDB] load failed:", e); return null; }
  }

  async function idbDelete(songId) {
    try {
      var db = await idbOpen();
      return new Promise(function(resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(songId);
        tx.oncomplete = function() { db.close(); resolve(true); };
        tx.onerror    = function() { db.close(); reject(tx.error); };
      });
    } catch (e) { console.warn("[IDB] delete failed:", e); return false; }
  }

  /* ══════════════════════════════════════
     Spectrogram Engine
     ══════════════════════════════════════ */
  function createSpectrogram(canvas, playerEl) {
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var audioCtx = null, analyser = null, source = null;
    var connected = false, rafId = null, running = false;

    var STOPS = [
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
    var LUT = new Array(256);
    for (var i = 0; i < 256; i++) {
      var t = i / 255;
      var lo = 0, hi = STOPS.length - 1;
      for (var s = 0; s < STOPS.length - 1; s++) {
        if (t >= STOPS[s][0] && t <= STOPS[s + 1][0]) { lo = s; hi = s + 1; break; }
      }
      var range = STOPS[hi][0] - STOPS[lo][0] || 1;
      var f = (t - STOPS[lo][0]) / range;
      LUT[i] = [
        Math.round(STOPS[lo][1] + (STOPS[hi][1] - STOPS[lo][1]) * f),
        Math.round(STOPS[lo][2] + (STOPS[hi][2] - STOPS[lo][2]) * f),
        Math.round(STOPS[lo][3] + (STOPS[hi][3] - STOPS[lo][3]) * f)
      ];
    }

    var zoom = 1, writeX = 0, freqData = null;
    var noiseFloor = 5;
    var peakVal = 80;
    var labelMargin = 0;

    var FREQ_ZONES = [
      { freq: 300,  label: "300 Hz",  desc: "гласные",   color: "rgba(55,230,255,0.45)" },
      { freq: 3000, label: "3 kHz",   desc: "согласные", color: "rgba(215,60,195,0.45)" },
      { freq: 6000, label: "6 kHz",   desc: "шипящие",   color: "rgba(155,95,238,0.4)" }
    ];

    var ZONE_BANDS = [
      { from: 0,    to: 300,   bg: "rgba(55,230,255,0.015)" },
      { from: 300,  to: 3000,  bg: "rgba(215,60,195,0.012)" },
      { from: 3000, to: 24000, bg: "rgba(155,95,238,0.01)" }
    ];

    function getMaxFreq() {
      return audioCtx ? audioCtx.sampleRate / 2 : 22050;
    }

    function freqToY(freq, H) {
      var mf = getMaxFreq() / zoom;
      var r = freq / mf;
      return r > 1 ? -1 : Math.round(H * (1 - r));
    }

    function computeLabelMargin() {
      var dpr = window.devicePixelRatio || 1;
      var fs = Math.round(10 * dpr);
      ctx.font = "bold " + fs + "px -apple-system,BlinkMacSystemFont,sans-serif";
      var maxW = 0;
      FREQ_ZONES.forEach(function(z) {
        var txt = z.label + "  " + z.desc;
        var tw = ctx.measureText(txt).width;
        if (tw > maxW) maxW = tw;
      });
      var p = 3 * dpr;
      var bx = 3 * dpr;
      labelMargin = Math.ceil(bx + maxW + p * 2 + 4 * dpr);
    }

    function drawZones() {
      var W = canvas.width, H = canvas.height;
      var mf = getMaxFreq() / zoom;
      var dpr = window.devicePixelRatio || 1;

      ZONE_BANDS.forEach(function(b) {
        if (b.from >= mf) return;
        var y1 = Math.max(0, freqToY(Math.min(b.to, mf), H));
        var y2 = Math.min(H, freqToY(b.from, H));
        ctx.fillStyle = b.bg;
        ctx.fillRect(0, y1, W, y2 - y1);
      });

      var fs = Math.round(10 * dpr);
      ctx.font = "bold " + fs + "px -apple-system,BlinkMacSystemFont,sans-serif";
      ctx.textBaseline = "bottom";

      FREQ_ZONES.forEach(function(z) {
        if (z.freq >= mf) return;
        var y = freqToY(z.freq, H);
        if (y < 0 || y > H) return;

        ctx.strokeStyle = z.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([5 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.setLineDash([]);

        var txt = z.label + "  " + z.desc;
        var tw = ctx.measureText(txt).width;
        var p = 3 * dpr;

        ctx.fillStyle = "rgba(0,0,0,0.75)";
        var bx = 3 * dpr, by = y - fs - p * 2, bw = tw + p * 2, bh = fs + p * 2;
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
      var dpr = window.devicePixelRatio || 1;
      var r = canvas.getBoundingClientRect();
      canvas.width  = Math.round(r.width  * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "rgb(" + LUT[0][0] + "," + LUT[0][1] + "," + LUT[0][2] + ")";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      computeLabelMargin();
      writeX = labelMargin;
      noiseFloor = 5; peakVal = 80;
      drawZones();
    }

    function drawColumn() {
      if (!analyser || !freqData) return;
      analyser.getByteFrequencyData(freqData);

      var W = canvas.width, H = canvas.height;
      if (writeX >= W) {
        var dataW = W - labelMargin;
        if (dataW > 1) {
          var img = ctx.getImageData(labelMargin + 1, 0, dataW - 1, H);
          ctx.fillStyle = "rgb(" + LUT[0][0] + "," + LUT[0][1] + "," + LUT[0][2] + ")";
          ctx.fillRect(0, 0, W, H);
          ctx.putImageData(img, labelMargin, 0);
          drawZones();
        }
        writeX = W - 1;
      }

      var totalBins = analyser.frequencyBinCount;
      var visBins = Math.floor(totalBins / zoom);

      var frameMin = 255, frameMax = 0;
      for (var b = 0; b < visBins; b++) {
        var v = freqData[b];
        if (v < frameMin) frameMin = v;
        if (v > frameMax) frameMax = v;
      }
      noiseFloor += (frameMin - noiseFloor) * 0.05;
      peakVal    += (Math.max(frameMax, noiseFloor + 20) - peakVal) * 0.08;
      var floor = Math.max(0, noiseFloor - 2);
      var dynRange = Math.max(30, peakVal - floor);

      var col = ctx.createImageData(1, H);
      var d = col.data;

      for (var y = 0; y < H; y++) {
        var bin = Math.floor((1 - y / H) * visBins);
        var raw = freqData[bin] || 0;
        var norm = dynRange > 0 ? (raw - floor) / dynRange : 0;
        if (!isFinite(norm)) norm = 0;
        norm = Math.max(0, Math.min(1, norm));
        norm = Math.pow(norm, 0.45);
        var idx = Math.max(0, Math.min(255, Math.round(norm * 255)));
        var c = LUT[idx] || LUT[0];
        var off = y * 4;
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

    var resizeT = null;
    window.addEventListener("resize", function() {
      clearTimeout(resizeT);
      resizeT = setTimeout(function() { if (canvas.offsetParent !== null) resetCanvas(); }, 200);
    });

    resetCanvas();
    return { start: start, stop: stop, clear: clear, zoomIn: zoomIn, zoomOut: zoomOut, getZoom: getZoom, ensureAudio: ensureAudio, resetCanvas: resetCanvas };
  }

  /* storage consent */
  function showStorageConsent() {
    var KEY = "lyricear_storage_ok";
    if (localStorage.getItem(KEY)) return;
    var bar = document.createElement("div");
    bar.id = "storageBanner";
    bar.innerHTML =
      '<span>Этот сайт сохраняет прогресс и медиа в браузере. Данные не передаются на сервер.</span>' +
      '<button id="storageOk">Понятно</button>';
    document.body.appendChild(bar);
    $("#storageOk").addEventListener("click", function() { localStorage.setItem(KEY, "1"); bar.remove(); });
  }

  /* state helpers */
  function normalizeState(s) {
    s.ui = Object.assign(
      { showTranslationByDefault: false, showPhoneticByDefault: false,
        showWhyHeardByDefault: false, showOriginalByDefault: false },
      s.ui || {}
    );
    s.song = s.song || {};
    s.song.media = s.song.media || {};
    if (!Array.isArray(s.items)) s.items = [];
    s.items.forEach(function(it, i) {
      if (!it.id) it.id = (s.song.id || "line") + "-" + String(i + 1).padStart(3, "0");
      if (!("start" in it))    it.start = null;
      if (!("end" in it))      it.end   = null;
      if (typeof it.learned    !== "boolean") it.learned = false;
      if (typeof it.confidence !== "number")  it.confidence = null;
      if (typeof it.phonetic_user !== "string") it.phonetic_user = "";
    });
  }

  function mergeProgress(remote, local) {
    var out = structuredClone(remote);
    if (local && local.ui) out.ui = Object.assign({}, out.ui || {}, local.ui);
    var m = new Map((local.items || []).map(function(x) { return [x.id, x]; }));
    (out.items || []).forEach(function(it) {
      var l = m.get(it.id); if (!l) return;
      it.start   = l.start != null ? l.start : (it.start != null ? it.start : null);
      it.end     = l.end != null ? l.end : (it.end != null ? it.end : null);
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
    return slug.indexOf("/") !== -1 ? slug : "data/songs/" + slug + ".json";
  }

  /* ══════════════════════════════════════
     SONG PAGE
     ══════════════════════════════════════ */
  async function bootSongPage() {
    var slug = getSongSlug();
    if (!slug) return;

    var JSON_URL = slugToUrl(slug);
    var PREFIX   = "lyricear_v1::";

    var state;
    try {
      var remote = await fetchJson(JSON_URL);
      var key    = PREFIX + (remote.song && remote.song.id ? remote.song.id : slug);
      var raw    = localStorage.getItem(key);
      var local  = raw ? JSON.parse(raw) : null;
      state = local ? mergeProgress(remote, local) : remote;
      state._storageKey = key;
    } catch (e) { toast("Не удалось загрузить песню", String(e)); return; }
    normalizeState(state);
    var songId = (state.song && state.song.id) ? state.song.id : slug;
    if (state.song && state.song.title) document.title = state.song.title + " — LyricEar";

    /* DOM refs */
    var player         = $("#player");
    var videoWrap      = $("#videoWrap");
    var btnPlayOverlay = $("#btnPlayOverlay");
    var mediaPick      = $("#mediaPick");
    var btnLoadLocal   = $("#btnLoadLocal");
    var btnLoadYaDisk  = $("#btnLoadYaDisk");
    var btnForgetMedia = $("#btnForgetMedia");
    var mediaSource    = $("#mediaSource");
    var mediaName      = $("#mediaName");
    var lamp           = $("#mediaLamp");
    var elNow          = $("#tNow");
    var btnPlay        = $("#btnPlay");
    var playProgress   = $("#playProgress");
    var playTime       = $("#playTime");
    var overlaySeek    = $("#overlaySeek");
    var btnPlaySeg     = $("#btnPlaySeg");
    var btnStart       = $("#btnStart");
    var btnEnd         = $("#btnEnd");
    var btnClear       = $("#btnClear");
    var loopToggle     = $("#loopToggle");
    var autoNextToggle = $("#autoNextToggle");
    var globalShowOrig  = $("#globalShowOrig");
    var globalShowTrans = $("#globalShowTrans");
    var globalShowPhon  = $("#globalShowPhon");
    var globalShowWhy   = $("#globalShowWhy");
    var linesHost       = $("#lines");
    var saveIndicator   = $("#saveIndicator");

    var specCanvas  = $("#spectrogramCanvas");
    var specWrap    = $("#spectrogramWrap");
    var specToggle  = $("#spectrogramToggle");
    var specZoomIn  = $("#specZoomIn");
    var specZoomOut = $("#specZoomOut");
    var specZoomLbl = $("#specZoomLabel");

    var spec = null;
    var activeIndex = 0;
    var loopTimer   = null;

    /* header */
    function applyHeader() {
      var t = $("#songTitle");  if (t) t.textContent = (state.song && state.song.title)  || "—";
      var a = $("#songArtist"); if (a) a.textContent = (state.song && state.song.artist) || "—";
      var l = $("#songLang");   if (l) l.textContent = (state.song && (state.song.languageName || state.song.language)) || "—";
      var h = $("#songHint");   if (h) h.textContent = (state.song && state.song.hint)   || "";
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

    /* Collapse media source after file is loaded */
    function collapseMediaSource() {
      if (mediaSource) mediaSource.classList.add("collapsed");
    }
    function expandMediaSource() {
      if (mediaSource) mediaSource.classList.remove("collapsed");
    }

    /* save */
    var saveT = null;
    function save() {
      clearTimeout(saveT);
      saveT = setTimeout(function() {
        try { localStorage.setItem(state._storageKey, JSON.stringify(state)); } catch(e) {}
        if (saveIndicator) {
          saveIndicator.classList.add("flash");
          setTimeout(function() { saveIndicator.classList.remove("flash"); }, 600);
        }
      }, 300);
    }

    /* media type */
    var VID_RE = /\.(mp4|mkv|webm|avi|mov|m4v|ogv)$/i;
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

    /* Play overlay */
    function syncOverlay() {
      if (!btnPlayOverlay || !videoWrap) return;
      if (player.paused) videoWrap.classList.add("paused");
      else videoWrap.classList.remove("paused");
      btnPlayOverlay.textContent = player.paused ? "\u25B6" : "\u23F8";
    }

    if (btnPlayOverlay) {
      btnPlayOverlay.addEventListener("click", function(e) {
        e.stopPropagation();
        if (!player.src && !player.currentSrc) { toast("Сначала выберите файл"); return; }
        if (player.paused) player.play().catch(function(){});
        else player.pause();
      });
    }

    if (videoWrap) {
      videoWrap.addEventListener("click", function(e) {
        if (e.target.closest("button")) return;
        if (e.target.closest(".overlay-progress")) return;
        if (!player.src && !player.currentSrc) return;
        if (player.paused) player.play().catch(function(){});
        else player.pause();
      });
    }

    /* Spectrogram helpers */
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
      if (player._url) try { URL.revokeObjectURL(player._url); } catch(e) {}
      var url = URL.createObjectURL(blob);
      player._url = url;
      applyMode(isVideo(name, mime));
      player.src = url;
      player.load();
      setLamp(src);
      showMediaN(name);
      showForgetBtn(true);
      if (btnLoadLocal) btnLoadLocal.classList.remove("pulse");
      collapseMediaSource();
      ensureSpec();
      if (persist) {
        var ok = await idbSave(songId, blob, name, mime);
        toast(ok ? "Файл сохранён в кэш" : "Файл открыт", name);
      }
    }

    /* restore from IDB */
    async function tryRestore() {
      var c = await idbLoad(songId);
      if (!c || !c.blob) return false;
      await loadBlob(c.blob, c.name, c.type, "cached", false);
      toast("Медиа из кэша", c.name);
      return true;
    }

    /* local file */
    if (btnLoadLocal && mediaPick) {
      btnLoadLocal.addEventListener("click", function() { mediaPick.click(); });
      mediaPick.addEventListener("change", function() {
        var f = mediaPick.files && mediaPick.files[0];
        if (f) loadBlob(f, f.name, f.type, "local", true);
      });
    }

    /* forget */
    if (btnForgetMedia) {
      btnForgetMedia.addEventListener("click", async function() {
        if (!confirm("Удалить медиа из кэша?")) return;
        await idbDelete(songId);
        if (player._url) try { URL.revokeObjectURL(player._url); } catch(e) {}
        player.removeAttribute("src"); player.load();
        applyMode(false); setLamp("none"); showMediaN(""); showForgetBtn(false);
        expandMediaSource();
        if (spec) { spec.stop(); spec.clear(); }
        toast("Медиа удалено");
      });
    }

    /* YaDisk */
    if (btnLoadYaDisk) {
      var yd = state.song && state.song.media && state.song.media.yadisk;
      if (!yd) { btnLoadYaDisk.style.display = "none"; }
      else {
        btnLoadYaDisk.addEventListener("click", function() {
          window.open(yd, "yadisk", "width=700,height=500");
          if (btnLoadLocal) btnLoadLocal.classList.add("pulse");
          toast("Скачайте и откройте через Файл");
        });
      }
    }

    /* play / pause */
    function fmtTime(t) {
      if (!Number.isFinite(t)) return "0:00";
      var m = Math.floor(t / 60);
      var s = Math.floor(t % 60);
      return m + ":" + String(s).padStart(2, "0");
    }

    if (btnPlay) {
      btnPlay.addEventListener("click", function() {
        if (!player.src && !player.currentSrc) { toast("Сначала выберите файл"); return; }
        if (player.paused) player.play().catch(function(){});
        else player.pause();
      });
    }
    player.addEventListener("play",  function() {
      if (btnPlay) btnPlay.textContent = "\u23F8";
      syncOverlay();
      specStart();
    });
    player.addEventListener("pause", function() {
      if (btnPlay) btnPlay.textContent = "\u25B6";
      syncOverlay();
      specStop();
    });
    player.addEventListener("ended", function() {
      /* If loop is checked and no segment is playing → loop whole track */
      if (loopToggle && loopToggle.checked && !loopTimer) {
        player.currentTime = 0;
        specClear();
        player.play().catch(function(){});
        return;
      }
      if (btnPlay) btnPlay.textContent = "\u25B6";
      syncOverlay();
      specStop();
    });
    player.addEventListener("seeked", function() { if (!player.paused) specClear(); });

    /* progress bar + timecode + overlay seek */
    player.addEventListener("timeupdate", function() {
      var ct = player.currentTime || 0;
      if (elNow) elNow.textContent = ct.toFixed(2) + "s";
      if (playProgress && player.duration)
        playProgress.value = (ct / player.duration * 1000).toFixed(0);
      if (overlaySeek && player.duration)
        overlaySeek.value = (ct / player.duration * 1000).toFixed(0);
      if (playTime)
        playTime.textContent = fmtTime(ct) + "/" + fmtTime(player.duration);
    });
    if (playProgress) {
      playProgress.addEventListener("input", function() {
        if (player.duration) player.currentTime = (playProgress.value / 1000) * player.duration;
      });
    }
    if (overlaySeek) {
      overlaySeek.addEventListener("input", function() {
        if (player.duration) player.currentTime = (overlaySeek.value / 1000) * player.duration;
      });
      overlaySeek.addEventListener("click", function(e) { e.stopPropagation(); });
    }

    player.addEventListener("loadedmetadata", function() {
      if (btnStart) btnStart.disabled = false;
      if (btnEnd)   btnEnd.disabled   = false;
      renderSegStatus();
      syncOverlay();
    });
    player.addEventListener("loadeddata", function() {
      if (btnLoadLocal) btnLoadLocal.classList.remove("pulse");
      if (player.videoHeight > 0) applyMode(true);
    });
    player.addEventListener("error", function() { toast("Ошибка медиа"); setLamp("none"); });

    /* spectrogram UI */
    if (specToggle && specWrap) {
      specToggle.addEventListener("click", function() {
        var c = specWrap.classList.toggle("collapsed");
        specToggle.textContent = c ? "📊 Спектрограмма ▸" : "📊 Спектрограмма ▾";
        if (!c) {
          setTimeout(function() {
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
    function updateZL() { if (specZoomLbl && spec) specZoomLbl.textContent = "×" + spec.getZoom(); }
    if (specZoomIn)  specZoomIn.addEventListener("click",  function() { if (spec) { spec.zoomIn();  updateZL(); } });
    if (specZoomOut) specZoomOut.addEventListener("click", function() { if (spec) { spec.zoomOut(); updateZL(); } });

    /* segment controls */
    function renderSegStatus() {
      var el = $("#segStatus"); if (!el) return;
      var it = state.items[activeIndex];
      var s = it ? it.start : null;
      var e = it ? it.end : null;
      el.innerHTML =
        '<span class="pill">Строка: <span class="mono">' + (activeIndex + 1) + '/' + state.items.length + '</span></span>' +
        '<span class="pill">S: <span class="mono">' + (s == null ? "—" : Number(s).toFixed(2)) + '</span></span>' +
        '<span class="pill">E: <span class="mono">' + (e == null ? "—" : Number(e).toFixed(2)) + '</span></span>';
      var ready = s != null && e != null && Number(e) > Number(s);
      if (btnPlaySeg) btnPlaySeg.disabled = !ready;
      if (btnClear)   btnClear.disabled   = !(s != null || e != null);
      if (btnStart)   btnStart.disabled   = !(player && player.readyState >= 1);
      if (btnEnd)     btnEnd.disabled     = !(player && player.readyState >= 1);
    }

    function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }

    function playSegment() {
      var it = state.items[activeIndex];
      var s = it ? it.start : null;
      var e = it ? it.end : null;
      if (!(s != null && e != null && Number(e) > Number(s))) { toast("Нужны Start и End"); return; }
      stopLoop();
      player.currentTime = Number(s);
      specClear();
      player.play().catch(function(){});

      loopTimer = setInterval(function() {
        if (!player || player.paused) return;
        if (player.currentTime >= Number(e) - 0.03) {
          if (loopToggle && loopToggle.checked) {
            player.currentTime = Number(s);
            specClear();
          } else {
            stopLoop(); player.pause();
            if (autoNextToggle && autoNextToggle.checked) {
              var nx = Math.min(activeIndex + 1, state.items.length - 1);
              if (nx !== activeIndex) {
                setActive(nx, true);
                var ni = state.items[nx];
                if (ni && ni.start != null && ni.end != null && Number(ni.end) > Number(ni.start))
                  setTimeout(playSegment, 120);
              }
            }
          }
        }
      }, 30);
    }

    if (btnPlaySeg) btnPlaySeg.addEventListener("click", playSegment);

    if (btnStart) btnStart.addEventListener("click", function() {
      var it = state.items[activeIndex];
      it.start = Number(player.currentTime.toFixed(2));
      if (it.end != null && Number(it.end) <= Number(it.start)) it.end = null;
      save(); renderLines();
    });
    if (btnEnd) btnEnd.addEventListener("click", function() {
      var it = state.items[activeIndex];
      it.end = Number(player.currentTime.toFixed(2));
      if (it.start != null && Number(it.end) <= Number(it.start)) { toast("End ≤ Start"); it.end = null; }
      save(); renderLines();
    });
    if (btnClear) btnClear.addEventListener("click", function() {
      var it = state.items[activeIndex];
      it.start = null; it.end = null;
      save(); renderLines();
    });

    /* active line */
    function setActive(idx, seek) {
      activeIndex = Math.max(0, Math.min(idx, state.items.length - 1));
      renderLines();
      var it = state.items[activeIndex];
      if (seek && it && it.start != null && Number.isFinite(it.start))
        player.currentTime = Math.max(0, Number(it.start));

      var el = linesHost.children[activeIndex];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    /* render lines */
    function renderLines() {
      var sO = globalShowOrig  && globalShowOrig.checked  || false;
      var sT = globalShowTrans && globalShowTrans.checked || false;
      var sP = globalShowPhon  && globalShowPhon.checked  || false;
      var sW = globalShowWhy   && globalShowWhy.checked   || false;
      state.ui.showOriginalByDefault    = sO;
      state.ui.showTranslationByDefault = sT;
      state.ui.showPhoneticByDefault    = sP;
      state.ui.showWhyHeardByDefault    = sW;

      linesHost.innerHTML = "";

      state.items.forEach(function(it, idx) {
        var isAct = idx === activeIndex;
        var hasT  = it.start != null && it.end != null && Number(it.end) > Number(it.start);

        var line = document.createElement("div");
        line.className = "line" + (isAct ? " active" : "") + (it.learned ? " learned" : "");

        var hdr = document.createElement("div"); hdr.className = "line-header";
        var num = document.createElement("span"); num.className = "line-num"; num.textContent = idx + 1;
        var inp = document.createElement("input");
        inp.type = "text"; inp.className = "user-heard"; inp.placeholder = "Напиши, что слышишь…";
        inp.value = it.phonetic_user || "";
        inp.addEventListener("input", function() { it.phonetic_user = inp.value; save(); });
        inp.addEventListener("click", function(e) { e.stopPropagation(); });
        inp.addEventListener("focus", function() {
          if (idx !== activeIndex) setActive(idx, false);
        });
        hdr.appendChild(num); hdr.appendChild(inp);

        var origRow = document.createElement("div"); origRow.className = "orig-row";
        var revealed = sO;
        var origTxt = document.createElement("span"); origTxt.className = "orig-text";
        origTxt.textContent = it.text || "—"; origTxt.style.display = revealed ? "inline" : "none";
        var btnR = document.createElement("button"); btnR.className = "tiny btn-reveal";
        btnR.textContent = revealed ? "Скрыть" : "Показать";
        btnR.addEventListener("click", function(e) {
          e.stopPropagation(); revealed = !revealed;
          origTxt.style.display = revealed ? "inline" : "none";
          btnR.textContent = revealed ? "Скрыть" : "Показать";
        });
        origRow.appendChild(btnR); origRow.appendChild(origTxt);

        var phonRow  = document.createElement("div");
        phonRow.className = "sub sub-phon" + (sP ? " visible" : "");
        if (it.phonetic) phonRow.innerHTML = '<div class="subCard"><b>🔊</b> <span class="mono phon-author">' + esc(it.phonetic) + '</span></div>';

        var transRow = document.createElement("div");
        transRow.className = "sub sub-trans" + (sT ? " visible" : "");
        if (it.translation) transRow.innerHTML = '<div class="subCard"><span class="muted">💬</span> ' + esc(it.translation) + '</div>';

        var whyRow = document.createElement("div");
        whyRow.className = "sub sub-why" + (sW ? " visible" : "");
        if (it.why) {
          var conf = typeof it.confidence === "number"
            ? ' <span class="pill">~' + (clamp01(it.confidence)*100).toFixed(0) + '%</span>' : "";
          whyRow.innerHTML = '<div class="subCard"><b>🧠</b>' + conf + '<div style="margin-top:4px">' + esc(it.why) + '</div></div>';
        }

        var acts = document.createElement("div"); acts.className = "line-actions";
        function mb(t, c, fn) {
          var b = document.createElement("button");
          b.className = c; b.textContent = t;
          b.addEventListener("click", function(e) { e.stopPropagation(); fn(); });
          return b;
        }
        if (hasT) acts.appendChild(mb("▶", "tiny btn-primary", function() { setActive(idx, false); playSegment(); }));
        if (it.phonetic) acts.appendChild(mb("🔊", "tiny", function() { phonRow.classList.toggle("visible"); }));
        acts.appendChild(mb("💬", "tiny", function() { transRow.classList.toggle("visible"); }));
        if (it.why) acts.appendChild(mb("🧠", "tiny", function() { whyRow.classList.toggle("visible"); }));

        line.appendChild(hdr);
        line.appendChild(origRow);
        line.appendChild(phonRow);
        line.appendChild(transRow);
        line.appendChild(whyRow);
        line.appendChild(acts);
        line.addEventListener("click", function() { setActive(idx, true); });
        linesHost.appendChild(line);
      });

      renderSegStatus();
      save();
    }

    /* reset */
    var btnReset = $("#btnResetProgress");
    if (btnReset) {
      btnReset.addEventListener("click", async function() {
        if (!confirm("Сбросить прогресс?")) return;
        try {
          var r = await fetchJson(JSON_URL);
          var k = state._storageKey;
          state = r; state._storageKey = k;
          normalizeState(state); save(); applyHeader(); setActive(0, false);
          toast("Прогресс сброшен");
        } catch (e) { toast("Ошибка", String(e)); }
      });
    }

    /* toggles */
    if (globalShowOrig)  globalShowOrig.checked  = !!state.ui.showOriginalByDefault;
    if (globalShowTrans) globalShowTrans.checked = !!state.ui.showTranslationByDefault;
    if (globalShowPhon)  globalShowPhon.checked  = !!state.ui.showPhoneticByDefault;
    if (globalShowWhy)   globalShowWhy.checked   = !!state.ui.showWhyHeardByDefault;
    [globalShowOrig, globalShowTrans, globalShowPhon, globalShowWhy].forEach(function(el) {
      if (el) el.addEventListener("change", renderLines);
    });

    /* start */
    renderLines();
    setActive(0, false);

    /* restore media */
    tryRestore().then(function(ok) {
      if (!ok && btnLoadLocal) btnLoadLocal.classList.add("pulse");
    });

    /* ══════════════════════════════════════
       Keyboard shortcuts
       ══════════════════════════════════════ */
    document.addEventListener("keydown", function(e) {
      var tag = (e.target.tagName || "").toLowerCase();
      var inInput = (tag === "input" || tag === "textarea");

      if (e.key === " " && (!inInput || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!player.src && !player.currentSrc) return;
        player.paused ? player.play().catch(function(){}) : player.pause();
        return;
      }

      if (inInput) return;

      var k = e.key.toLowerCase();

      if (k === "s") { e.preventDefault(); if (btnStart && !btnStart.disabled) btnStart.click(); }

      if (k === "e") {
        e.preventDefault();
        if (btnEnd && !btnEnd.disabled) btnEnd.click();
        var nx = Math.min(activeIndex + 1, state.items.length - 1);
        if (nx !== activeIndex) setTimeout(function() { setActive(nx, false); }, 100);
      }

      if (k === "arrowdown" || k === "n") {
        e.preventDefault();
        setActive(Math.min(activeIndex + 1, state.items.length - 1), false);
      }

      if (k === "arrowup" || k === "p") {
        e.preventDefault();
        setActive(Math.max(activeIndex - 1, 0), false);
      }

      if (k === "r") { e.preventDefault(); playSegment(); }

      if (k === "l") {
        e.preventDefault();
        if (loopToggle) { loopToggle.checked = !loopToggle.checked; }
      }

      if (k === "arrowleft") {
        e.preventDefault();
        if (player.duration) player.currentTime = Math.max(0, player.currentTime - 3);
      }

      if (k === "arrowright") {
        e.preventDefault();
        if (player.duration) player.currentTime = Math.min(player.duration, player.currentTime + 3);
      }
    });

    toast("Клавиши: Space, S, E, R, L, ↑↓←→");
  }

  /* ══════════════════════════════════════
     HOME PAGE
     ══════════════════════════════════════ */
  async function bootHome() {
    var root = document.documentElement;
    if (!root.dataset.catalog) return;
    var list = $("#songsList"), langSel = $("#langFilter"), search = $("#q");
    var catalog;
    try { catalog = await fetchJson(root.dataset.catalog); } catch (e) { toast("Каталог не загружен", String(e)); return; }
    var songs = catalog.songs || [], langs = catalog.languages || [];
    if (langSel) {
      langSel.innerHTML = '<option value="">Все языки</option>' +
        langs.map(function(l) { return '<option value="' + esc(l.code) + '">' + esc(l.name) + '</option>'; }).join("");
    }
    function render() {
      var q    = (search && search.value || "").trim().toLowerCase();
      var lang = (langSel && langSel.value) || "";
      var f = songs.filter(function(s) {
        var okL = !lang || s.language === lang;
        var hay = (s.title + " " + s.artist + " " + (s.languageName || "")).toLowerCase();
        return okL && (!q || hay.indexOf(q) !== -1);
      });
      var c = $("#count"); if (c) c.textContent = f.length;
      if (!list) return;
      list.innerHTML = "";
      f.forEach(function(s) {
        var a = document.createElement("a"); a.className = "songCard"; a.href = s.url;
        a.innerHTML =
          '<div class="songTitle">' + esc(s.title) + '</div>' +
          '<div class="songMeta"><span class="pill">' + esc(s.artist||"—") + '</span>' +
          '<span class="pill">' + esc(s.languageName||s.language||"—") + '</span></div>' +
          '<div class="songSmall">' + esc(s.short||"") + '</div>';
        list.appendChild(a);
      });
    }
    if (langSel) langSel.addEventListener("change", render);
    if (search)  search.addEventListener("input", render);
    render();
  }

  /* ══════════════════════════════════════
     BOOT
     ══════════════════════════════════════ */
  window.addEventListener("DOMContentLoaded", async function() {
    showStorageConsent();

    var logo = document.getElementById("logoBar");
    if (logo) {
      var lastY = 0;
      window.addEventListener("scroll", function() {
        var y = window.scrollY;
        if (y > lastY && y > 60) logo.classList.add("hidden");
        else logo.classList.remove("hidden");
        lastY = y;
      }, { passive: true });
    }

    try { await bootSongPage(); } catch(e) { console.error("bootSongPage error:", e); }
    try { await bootHome(); }     catch(e) { console.error("bootHome error:", e); }
  });
})();
