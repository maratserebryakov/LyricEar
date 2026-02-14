function createSpectrogram(canvas, playerEl) {
    const ctx = canvas.getContext("2d");
    let audioCtx = null, analyser = null, source = null;
    let connected = false, rafId = null, running = false;

    const STOPS = [
      [0.00,  10,   8,  28], [0.15,  30,  15,  70],
      [0.30,  70,  20, 120], [0.50, 140,  40, 170],
      [0.70, 200,  60, 180], [0.85, 240, 120, 200],
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

    let zoom = 1, writeX = 0, freqData = null;

    /* ── frequency zone labels ── */
    const FREQ_ZONES = [
      { freq: 300,  label: "300",  desc: "гласные ▲", color: "rgba(34,197,94,0.7)" },
      { freq: 3000, label: "3k",   desc: "согл. ▲",   color: "rgba(245,158,11,0.7)" },
      { freq: 6000, label: "6k",   desc: "шип. ▲",    color: "rgba(239,68,68,0.5)" },
    ];

    const ZONE_BANDS = [
      { from: 0,    to: 300,  label: "гласные · бас",         bg: "rgba(34,197,94,0.06)" },
      { from: 300,  to: 3000, label: "согласные · речь",      bg: "rgba(245,158,11,0.06)" },
      { from: 3000, to: 24000,label: "шипящие · s t k",       bg: "rgba(239,68,68,0.04)" },
    ];

    function getMaxFreq() {
      if (!audioCtx) return 22050;
      return audioCtx.sampleRate / 2;
    }

    function freqToY(freq, H) {
      const maxFreq = getMaxFreq() / zoom;
      const ratio = freq / maxFreq;
      if (ratio > 1) return -1; // above visible range
      return Math.round(H * (1 - ratio));
    }

    function drawZones() {
      const W = canvas.width, H = canvas.height;
      const maxFreq = getMaxFreq() / zoom;
      const dpr = window.devicePixelRatio || 1;

      // band backgrounds
      ZONE_BANDS.forEach(band => {
        if (band.from >= maxFreq) return;
        const yTop    = freqToY(Math.min(band.to, maxFreq), H);
        const yBottom = freqToY(band.from, H);
        if (yTop < 0 && yBottom < 0) return;
        const y1 = Math.max(0, yTop);
        const y2 = Math.min(H, yBottom);
        ctx.fillStyle = band.bg;
        ctx.fillRect(0, y1, W, y2 - y1);
      });

      // horizontal lines + labels
      const fontSize = Math.round(10 * dpr);
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textBaseline = "bottom";

      FREQ_ZONES.forEach(zone => {
        if (zone.freq >= maxFreq) return;
        const y = freqToY(zone.freq, H);
        if (y < 0 || y > H) return;

        // dashed line
        ctx.strokeStyle = zone.color;
        ctx.lineWidth = 1;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // label background
        const text = `${zone.label} ${zone.desc}`;
        const tw = ctx.measureText(text).width;
        const pad = 3 * dpr;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(2 * dpr, y - fontSize - pad, tw + pad * 2, fontSize + pad);

        // label text
        ctx.fillStyle = zone.color;
        ctx.fillText(text, 2 * dpr + pad, y - 2 * dpr);
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
        analyser.maxDecibels = -20;
        source = audioCtx.createMediaElementSource(playerEl);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        freqData = new Uint8Array(analyser.frequencyBinCount);
        connected = true;
        return true;
      } catch (e) { console.warn("[Spectrogram] Web Audio init failed:", e); return false; }
    }

    function resetCanvas() {
      const dpr  = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width  = Math.round(rect.width  * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bg = LUT[0];
      ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      writeX = 0;
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
      const visBins   = Math.floor(totalBins / zoom);
      const col = ctx.createImageData(1, H);
      const d   = col.data;
      for (let y = 0; y < H; y++) {
        const bin = Math.floor((1 - y / H) * visBins);
        const val = Math.max(0, Math.min(255, freqData[bin] || 0));
        const c   = LUT[val];
        const off = y * 4;
        d[off] = c[0]; d[off+1] = c[1]; d[off+2] = c[2]; d[off+3] = 255;
      }
      ctx.putImageData(col, writeX, 0);
      writeX++;

      // redraw zone overlays on right edge area
      drawZones();
    }

    function loop() { if (!running) return; drawColumn(); rafId = requestAnimationFrame(loop); }

    function start() {
      if (!ensureAudio()) return;
      if (audioCtx.state === "suspended") audioCtx.resume();
      if (running) return;
      running = true;
      loop();
    }
    function stop()  { running = false; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
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
