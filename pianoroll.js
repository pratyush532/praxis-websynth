// ---------------------------------------------------------------
// Piano roll — 1/8-note step grid with its own transport.
//
// Uses these globals from synth.js: initAudio, ctx, startVoice,
// releaseVoice, killVoice, noteOn, noteOff, isBlack.
//
// Mouse:
//   click / drag on empty cell   draw a note (drag sideways for length)
//   drag a note                  move it (left/right = time, up/down = pitch)
//   drag a note's right edge     resize it
//   click a note, or right-click delete it
//   mouse wheel                  scroll through octaves (Shift+wheel = sideways)
//   Space                        play / stop
// ---------------------------------------------------------------
(() => {
  const el = (id) => document.getElementById(id);

  // ---------- Layout ----------
  const TOP_MIDI = 107;                    // B7, top row
  const LOW_MIDI = 24;                     // C1, bottom row
  const ROWS = TOP_MIDI - LOW_MIDI + 1;    // 84 rows = 7 octaves
  const ROW_H = 16;                        // px per semitone
  let colW = 32;                           // px per 1/8 note; recomputed so the pattern fills the window (24..64)
  const STEPS_PER_BAR = 8;                 // 4/4 time, eighth-note grid
  const KEYS_W = 56;                       // width of the piano column
  const RULER_H = 22;
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const scroller = el("roll-scroll");
  const keysC = el("roll-keys");
  const gridC = el("roll-grid");
  const rulerC = el("roll-ruler");
  const playhead = el("roll-playhead");
  const playBtn = el("roll-play");

  // ---------- State ----------
  const state = { bars: 2, bpm: 120, loop: true };
  let notes = [];                          // { step, midi, len }  (len in 1/8 notes)

  const totalSteps = () => state.bars * STEPS_PER_BAR;
  const stepDur = () => 60 / state.bpm / 2;          // seconds per 1/8 note
  const noteName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);   // 60 -> C4, same as synth.js
  const yOf = (m) => (TOP_MIDI - m) * ROW_H;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cellAt = (x, y) => ({ step: Math.floor(x / colW), midi: TOP_MIDI - Math.floor(y / ROW_H) });

  const noteAt = (step, midi) =>
    notes.find((n) => n.midi === midi && step >= n.step && step < n.step + n.len);
  const overlaps = (step, len, midi, ignore) =>
    notes.some((n) => n !== ignore && n.midi === midi && step < n.step + n.len && n.step < step + len);
  // Longest note that fits at `step` on this row before the next note / end of pattern.
  function maxLen(step, midi, ignore) {
    let end = totalSteps();
    for (const n of notes) if (n !== ignore && n.midi === midi && n.step >= step) end = Math.min(end, n.step);
    return Math.max(1, end - step);
  }

  // ---------- Drawing ----------
  function sizeCanvases() {
    // Few bars -> wide steps that fill the window; many bars -> narrower steps and sideways scrolling.
    colW = clamp(Math.floor((scroller.clientWidth - KEYS_W - 2) / totalSteps()), 24, 64);
    const W = totalSteps() * colW, H = ROWS * ROW_H;
    gridC.width = W;  gridC.height = H;
    gridC.style.width = W + "px";  gridC.style.height = H + "px";
    rulerC.width = W; rulerC.height = RULER_H;
    rulerC.style.width = W + "px"; rulerC.style.height = RULER_H + "px";
  }

  function drawKeys() {
    const dpr = window.devicePixelRatio || 1, H = ROWS * ROW_H;
    keysC.width = KEYS_W * dpr; keysC.height = H * dpr;
    keysC.style.width = KEYS_W + "px"; keysC.style.height = H + "px";
    const c = keysC.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.font = "10px system-ui, sans-serif"; c.textAlign = "right";
    for (let r = 0; r < ROWS; r++) {
      const m = TOP_MIDI - r, y = r * ROW_H, black = isBlack(m);
      c.fillStyle = black ? "#2a2c38" : "#d9dbe3";
      c.fillRect(0, y, KEYS_W, ROW_H);
      c.fillStyle = black ? "#15161d" : "#a7aab8";
      c.fillRect(0, y + ROW_H - 1, KEYS_W, 1);
      if (m % 12 === 0) { c.fillStyle = "#3b3e4e"; c.fillText(noteName(m), KEYS_W - 6, y + ROW_H - 4); }
    }
    c.fillStyle = "#0a0b10"; c.fillRect(KEYS_W - 1, 0, 1, H);
  }

  function drawRuler() {
    const c = rulerC.getContext("2d"), W = rulerC.width;
    c.fillStyle = "#12131a"; c.fillRect(0, 0, W, RULER_H);
    c.font = "11px system-ui, sans-serif"; c.textAlign = "left";
    for (let s = 0; s <= totalSteps(); s += 2) {                 // one tick per quarter note
      const x = s * colW + 0.5, bar = s % STEPS_PER_BAR === 0;
      c.fillStyle = bar ? "#7b8096" : "#3a3e52";
      c.fillRect(x, bar ? 0 : RULER_H - 7, 1, bar ? RULER_H : 7);
      if (bar && s < totalSteps()) { c.fillStyle = "#d8dbe6"; c.fillText(String(s / STEPS_PER_BAR + 1), x + 5, 15); }
    }
  }

  function drawGrid() {
    const c = gridC.getContext("2d"), W = gridC.width, H = gridC.height, total = totalSteps();
    for (let r = 0; r < ROWS; r++) {                              // row shading + lines
      const m = TOP_MIDI - r, y = r * ROW_H;
      c.fillStyle = isBlack(m) ? "#11121a" : "#181a24";
      c.fillRect(0, y, W, ROW_H);
      c.fillStyle = m % 12 === 0 ? "#3a3e52" : "#1f2230";         // brighter line under every C
      c.fillRect(0, y + ROW_H - 1, W, 1);
    }
    for (let s = 0; s <= total; s++) {                            // bar / beat / step lines
      c.fillStyle = s % STEPS_PER_BAR === 0 ? "#4a4f66" : s % 2 === 0 ? "#2f3346" : "#22253a";
      c.fillRect(s * colW, 0, 1, H);
    }
    c.font = "10px system-ui, sans-serif"; c.textAlign = "left";
    for (const n of notes) {                                      // notes
      if (n.step >= total) continue;
      const x = n.step * colW + 1, y = yOf(n.midi) + 1;
      const w = Math.min(n.len, total - n.step) * colW - 2, h = ROW_H - 2;
      c.fillStyle = "#ff9f1c"; c.fillRect(x, y, w, h);
      c.fillStyle = "#ffd08a"; c.fillRect(x, y, w, 2);            // highlight on top edge
      c.fillStyle = "#c97800"; c.fillRect(x + w - 3, y, 3, h);    // resize handle on the right
      if (w >= 28) { c.fillStyle = "#2a1800"; c.fillText(noteName(n.midi), x + 4, y + h - 3); }
    }
  }

  // ---------- Mouse: drawing, moving, resizing, deleting ----------
  let drag = null;           // { mode: 'draw' | 'resize' | 'move', note, grab, moved, x0, y0 }
  let previewMidi = null;

  function preview(m) { stopPreview(); previewMidi = m; noteOn(m); }
  function stopPreview() { if (previewMidi != null) { noteOff(previewMidi); previewMidi = null; } }

  const local = (e) => { const r = gridC.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const inRange = (c) => c.step >= 0 && c.step < totalSteps() && c.midi >= LOW_MIDI && c.midi <= TOP_MIDI;
  const onRightEdge = (n, x) => (n.step + n.len) * colW - x <= 7;

  gridC.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    initAudio();                                    // first click also unlocks audio
    const { x, y } = local(e), cell = cellAt(x, y);
    if (!inRange(cell)) return;
    gridC.setPointerCapture(e.pointerId);
    const hit = noteAt(cell.step, cell.midi);
    if (hit) {
      drag = { mode: onRightEdge(hit, x) ? "resize" : "move", note: hit, grab: cell.step - hit.step, moved: false, x0: x, y0: y };
      if (drag.mode === "move") preview(hit.midi);
    } else {
      const n = { step: cell.step, midi: cell.midi, len: 1 };
      notes.push(n);
      drag = { mode: "draw", note: n, grab: 0, moved: false, x0: x, y0: y };
      preview(n.midi);
      drawGrid();
    }
  });

  gridC.addEventListener("pointermove", (e) => {
    const { x, y } = local(e), cell = cellAt(x, y);
    if (!drag) {                                    // just hovering: pick a cursor
      const n = inRange(cell) && noteAt(cell.step, cell.midi);
      gridC.style.cursor = n ? (onRightEdge(n, x) ? "ew-resize" : "grab") : "crosshair";
      return;
    }
    const n = drag.note;
    if (drag.mode === "draw" || drag.mode === "resize") {
      const wantLen = Math.floor(x / colW) + 1 - n.step;          // cell under the pointer is included
      const len = Math.min(Math.max(1, wantLen), maxLen(n.step, n.midi, n));
      if (len !== n.len) { n.len = len; drag.moved = true; drawGrid(); }
    } else {
      const step = clamp(cell.step - drag.grab, 0, Math.max(0, totalSteps() - n.len));
      const midi = clamp(cell.midi, LOW_MIDI, TOP_MIDI);
      if ((step !== n.step || midi !== n.midi) && !overlaps(step, n.len, midi, n)) {
        if (midi !== n.midi) preview(midi);
        n.step = step; n.midi = midi; drag.moved = true;
        drawGrid();
      }
    }
  });

  function endDrag(e, cancelled) {
    if (!drag) return;
    // A click on a note (press and release without moving it) deletes it.
    if (!cancelled && drag.mode === "move" && !drag.moved) notes = notes.filter((n) => n !== drag.note);
    drag = null;
    stopPreview();
    drawGrid();
  }
  gridC.addEventListener("pointerup", (e) => endDrag(e, false));
  gridC.addEventListener("pointercancel", (e) => endDrag(e, true));

  gridC.addEventListener("contextmenu", (e) => {     // right-click deletes
    e.preventDefault();
    const { x, y } = local(e), cell = cellAt(x, y);
    const n = inRange(cell) && noteAt(cell.step, cell.midi);
    if (n) { notes = notes.filter((m) => m !== n); drawGrid(); }
  });

  // Piano column: click / glide to hear pitches
  let keyDown = false;
  const keyMidi = (e) => clamp(TOP_MIDI - Math.floor((e.clientY - keysC.getBoundingClientRect().top) / ROW_H), LOW_MIDI, TOP_MIDI);
  keysC.addEventListener("pointerdown", (e) => { initAudio(); keyDown = true; keysC.setPointerCapture(e.pointerId); preview(keyMidi(e)); });
  keysC.addEventListener("pointermove", (e) => { if (keyDown) { const m = keyMidi(e); if (m !== previewMidi) preview(m); } });
  const keyUp = () => { keyDown = false; stopPreview(); };
  keysC.addEventListener("pointerup", keyUp);
  keysC.addEventListener("pointercancel", keyUp);

  // Keep the bar ruler lined up with the grid when it scrolls sideways
  scroller.addEventListener("scroll", () => { rulerC.style.transform = `translateX(${-scroller.scrollLeft}px)`; });

  // ---------- Transport ----------
  // The scheduler wakes up every 25 ms and hands the synth any notes that start
  // within the next 150 ms, with exact audio-clock times. That keeps timing tight
  // even if the page is busy drawing.
  const LOOKAHEAD = 0.15, TICK_MS = 25;
  let playing = false, timer = null, nextStep = 0, nextTime = 0, stopAt = null;
  let posQueue = [];                 // { time, step } for the playhead
  const scheduled = new Set();       // voices started by the roll (so Stop can silence them)

  function scheduleTick() {
    const horizon = ctx.currentTime + LOOKAHEAD;
    while (stopAt === null && nextTime < horizon) {
      const total = totalSteps(), sd = stepDur();
      if (nextStep >= total) nextStep = 0;            // bars were shortened during playback
      posQueue.push({ time: nextTime, step: nextStep });
      for (const n of notes) {
        if (n.step !== nextStep) continue;
        const v = startVoice(n.midi, nextTime);
        releaseVoice(v, nextTime + n.len * sd);
        scheduled.add(v);
      }
      nextTime += sd;
      nextStep++;
      if (nextStep >= total) {
        if (state.loop) nextStep = 0;
        else stopAt = nextTime;                       // let the last step finish, then stop
      }
    }
    for (const v of scheduled) if (v.endTime < ctx.currentTime) scheduled.delete(v);
  }

  function frame() {
    if (!playing) return;
    const now = ctx.currentTime;
    if (stopAt !== null && now >= stopAt) { stop(); return; }
    while (posQueue.length > 1 && posQueue[1].time <= now) posQueue.shift();
    const head = posQueue[0];
    const frac = head ? clamp((now - head.time) / stepDur(), 0, 1) : 0;
    const x = ((head ? head.step : 0) + frac) * colW;
    playhead.style.transform = `translateX(${x}px)`;
    const left = scroller.scrollLeft, visible = scroller.clientWidth - KEYS_W;   // follow the playhead
    if (x < left || x > left + visible - 20) scroller.scrollLeft = Math.max(0, x - 40);
    requestAnimationFrame(frame);
  }

  function play() {
    if (playing) return;
    initAudio();
    if (ctx.state === "suspended") ctx.resume();
    playing = true; stopAt = null; nextStep = 0; posQueue = [];
    nextTime = ctx.currentTime + 0.08;
    timer = setInterval(scheduleTick, TICK_MS);
    scheduleTick();
    playhead.style.display = "block";
    playBtn.textContent = "■ Stop"; playBtn.classList.add("on");
    requestAnimationFrame(frame);
  }

  function stop() {
    if (!playing) return;
    playing = false;
    clearInterval(timer);
    for (const v of scheduled) if (v.endTime > ctx.currentTime) killVoice(v);
    scheduled.clear();
    playhead.style.display = "none";
    playBtn.textContent = "▶ Play"; playBtn.classList.remove("on");
  }

  const toggle = () => (playing ? stop() : play());
  playBtn.onclick = () => { toggle(); playBtn.blur(); };
  window.addEventListener("keydown", (e) => {
    if (e.key !== " " || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.target.tagName)) return;
    e.preventDefault();
    toggle();
  });

  // ---------- Controls ----------
  el("roll-bpm").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    if (v >= 40 && v <= 240) state.bpm = v;
  });
  el("roll-bars").addEventListener("change", (e) => {
    state.bars = parseInt(e.target.value, 10);
    sizeCanvases(); drawRuler(); drawGrid();          // notes past the new end stay stored, just hidden
    e.target.blur();
  });
  el("roll-loop").addEventListener("change", (e) => {
    state.loop = e.target.checked;
    if (state.loop) stopAt = null;                    // un-ends a pending stop
    e.target.blur();
  });
  el("roll-clear").onclick = (e) => {
    if (notes.length && confirm("Clear all notes in the piano roll?")) { notes = []; drawGrid(); }
    e.target.blur();
  };

  // Re-fit the grid when the roll's width changes (window resized). Height changes need nothing.
  let fittedWidth = scroller.clientWidth, resizeTimer;
  const refit = () => {
    if (scroller.clientWidth === fittedWidth) return;
    fittedWidth = scroller.clientWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { sizeCanvases(); drawRuler(); drawGrid(); }, 60);
  };
  if (window.ResizeObserver) new ResizeObserver(refit).observe(scroller);
  else window.addEventListener("resize", refit);

  // Exposed so patterns can be saved / loaded later (e.g. through the Python backend).
  window.pianoRoll = {
    play, stop,
    colWidth: () => colW,
    getPattern: () => ({ bars: state.bars, bpm: state.bpm, loop: state.loop, notes: notes.map((n) => ({ ...n })) }),
    setPattern(p) {
      state.bars = [1, 2, 4, 8].includes(p.bars) ? p.bars : 2;
      state.bpm = clamp(+p.bpm || 120, 40, 240);
      state.loop = p.loop !== false;
      notes = (p.notes || []).filter((n) => n.midi >= LOW_MIDI && n.midi <= TOP_MIDI && n.step >= 0 && n.len >= 1)
                              .map((n) => ({ step: n.step | 0, midi: n.midi | 0, len: n.len | 0 }));
      el("roll-bars").value = state.bars; el("roll-bpm").value = state.bpm; el("roll-loop").checked = state.loop;
      sizeCanvases(); drawRuler(); drawGrid();
    },
  };

  // ---------- Boot ----------
  sizeCanvases();
  drawKeys();
  drawRuler();
  drawGrid();
  scroller.scrollTop = yOf(72);                       // open on C5 .. ~C3 so the keyboard's range is in view
})();