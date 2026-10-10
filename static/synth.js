// ---------------------------------------------------------------
// Web Synth v0.3 — keys, 2 oscillators, ADSR, filter, 4-band EQ, visuals
// (the piano roll lives in pianoroll.js and uses startVoice / releaseVoice below)
// Sound is generated in the browser with the Web Audio API.
// The Python backend only serves the page and stores presets.
// ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);

// ---------- State ----------
const params = {
  wave: "sawtooth",
  detune: 0,
  wave2: "sawtooth",
  oct2: 0,          // octave offset of oscillator 2
  detune2: 7,
  mix: 0.4,         // 0 = only osc 1, 1 = only osc 2
  eq1: 0, eq2: 0, eq3: 0, eq4: 0,   // dB
  attack: 0.02,
  decay: 0.2,
  sustain: 0.6,
  release: 0.4,
  cutoff: 0.75,     // 0..1, mapped exponentially to 40 Hz .. 18 kHz
  resonance: 1,
  volume: 0.5,
  octave: 3,
};

// ---------- Keyboard mapping ----------
// Lower row = base octave, upper row = one octave higher (classic tracker layout).
const LOWER = ["z","s","x","d","c","v","g","b","h","n","j","m"];            // C..B
const UPPER = ["q","2","w","3","e","r","5","t","6","y","7","u","i","8","o","9","p"]; // C..E (+1 oct+)
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const isBlack = (m) => [1,3,6,8,10].includes(m % 12);

const baseMidi = () => 12 * (params.octave + 1);       // octave 3 -> MIDI 48 (C3)
const KEY_COUNT = 29;                                   // 2 octaves + a major 3rd... C..E

function keyForMidi(midi) {
  const i = midi - baseMidi();
  if (i >= 0 && i < LOWER.length) return LOWER[i];
  const j = midi - (baseMidi() + 12);
  if (j >= 0 && j < UPPER.length) return UPPER[j];
  return null;
}
function midiForKey(k) {
  let i = LOWER.indexOf(k);
  if (i >= 0) return baseMidi() + i;
  i = UPPER.indexOf(k);
  if (i >= 0) return baseMidi() + 12 + i;
  return null;
}
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const cutoffToHz = (v) => 40 * Math.pow(18000 / 40, v);

// ---------- Audio graph ----------
let ctx, filter, master, analyser;
let eqNodes = [];
const voices = new Map();     // midi -> voice, notes currently held by keyboard / mouse
const liveVoices = new Set(); // every sounding or scheduled voice (keyboard + piano roll)

// 4-band EQ: low shelf, two peaking bands, high shelf
const EQ_BANDS = [
  { type: "lowshelf",  freq: 100,  q: 0.7 },
  { type: "peaking",   freq: 500,  q: 1.0 },
  { type: "peaking",   freq: 2000, q: 1.0 },
  { type: "highshelf", freq: 8000, q: 0.7 },
];
// osc mix: equal-power crossfade
const mixGains = (m) => [Math.cos(m * Math.PI / 2), Math.sin(m * Math.PI / 2)];

function initAudio() {
  if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  master = ctx.createGain();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;

  eqNodes = EQ_BANDS.map((b) => {
    const n = ctx.createBiquadFilter();
    n.type = b.type; n.frequency.value = b.freq; n.Q.value = b.q;
    return n;
  });
  // filter -> eq1 -> eq2 -> eq3 -> eq4 -> master -> analyser -> out
  let prev = filter;
  for (const n of eqNodes) { prev.connect(n); prev = n; }
  prev.connect(master);
  master.connect(analyser);
  analyser.connect(ctx.destination);
  applyParams();
  drawEq();
  $("status").textContent = "audio on";
  draw();
}

function applyParams() {
  if (!ctx) return;
  const t = ctx.currentTime;
  filter.frequency.setTargetAtTime(cutoffToHz(params.cutoff), t, 0.01);
  filter.Q.setTargetAtTime(params.resonance, t, 0.01);
  master.gain.setTargetAtTime(params.volume * 0.5, t, 0.01);
  eqNodes.forEach((n, i) => { n.gain.value = params["eq" + (i + 1)]; });
  const [a, b] = mixGains(params.mix);
  for (const v of liveVoices) {
    v.osc.detune.setTargetAtTime(params.detune, t, 0.01);
    v.osc2.detune.setTargetAtTime(params.detune2, t, 0.01);
    v.osc2.frequency.setTargetAtTime(midiToFreq(v.midi + 12 * params.oct2), t, 0.01);
    v.g1.gain.setTargetAtTime(a, t, 0.01);
    v.g2.gain.setTargetAtTime(b, t, 0.01);
  }
}

// ---------- Voices ----------
// startVoice / releaseVoice take an audio-clock time, so the piano roll can
// schedule notes slightly ahead of playback. noteOn / noteOff are the
// "right now" versions used by the keyboard and mouse.
function startVoice(midi, when) {
  const t = when;

  const osc = ctx.createOscillator();
  osc.type = params.wave;
  osc.frequency.value = midiToFreq(midi);
  osc.detune.value = params.detune;

  const osc2 = ctx.createOscillator();
  osc2.type = params.wave2;
  osc2.frequency.value = midiToFreq(midi + 12 * params.oct2);
  osc2.detune.value = params.detune2;

  const [ga, gb] = mixGains(params.mix);
  const g1 = ctx.createGain(); g1.gain.value = ga;
  const g2 = ctx.createGain(); g2.gain.value = gb;

  const gain = ctx.createGain();
  const env = { A: params.attack, D: params.decay, S: params.sustain }; // snapshot, used again at release
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(1, t + env.A);
  // decay toward sustain level (exponential-ish approach)
  gain.gain.setTargetAtTime(env.S, t + env.A, env.D / 3);

  osc.connect(g1); osc2.connect(g2);
  g1.connect(gain); g2.connect(gain);
  gain.connect(filter);
  osc.start(t); osc2.start(t);

  const v = { midi, osc, osc2, g1, g2, gain, t0: t, env, endTime: Infinity };
  osc.onended = () => {
    [osc, osc2, g1, g2, gain].forEach((n) => n.disconnect());
    liveVoices.delete(v);
  };
  liveVoices.add(v);
  return v;
}

// Start the release stage at audio time `when`. Rebuilds the gain curve from the
// start of the note, so it is correct even if `when` is still in the future.
// Calling it again on the same voice replaces the earlier release (used by killVoice).
function releaseVoice(v, when, tc = params.release / 4) {
  const t = Math.max(when, v.t0);
  const { A, D, S } = v.env;
  const el = t - v.t0;
  const g = v.gain.gain;
  g.cancelScheduledValues(v.t0);
  g.setValueAtTime(0, v.t0);
  if (el < A) {
    g.linearRampToValueAtTime(el / A, t);          // key let go mid-attack
  } else {
    g.linearRampToValueAtTime(1, v.t0 + A);
    g.setTargetAtTime(S, v.t0 + A, D / 3);
    g.setValueAtTime(S + (1 - S) * Math.exp(-(el - A) / (D / 3)), t);  // level at release
  }
  g.setTargetAtTime(0, t, tc);
  v.endTime = t + tc * 4 + 0.1;
  try { v.osc.stop(v.endTime); v.osc2.stop(v.endTime); } catch (e) { /* already stopped */ }
}

// Fast fade-out of a voice (used when the piano roll is stopped).
function killVoice(v) {
  releaseVoice(v, ctx.currentTime, 0.01);
}

function noteOn(midi) {
  initAudio();
  if (voices.has(midi)) return;
  voices.set(midi, startVoice(midi, ctx.currentTime));
  setKeyDown(midi, true);
}

function noteOff(midi) {
  const v = voices.get(midi);
  if (!v) return;
  voices.delete(midi);
  releaseVoice(v, ctx.currentTime);
  setKeyDown(midi, false);
}

function allNotesOff() {
  for (const m of [...voices.keys()]) noteOff(m);
}

// ---------- On-screen keyboard ----------
const kb = $("keyboard");

function buildKeyboard() {
  kb.innerHTML = "";
  const start = baseMidi();
  const end = start + KEY_COUNT;               // exclusive
  const whites = [];
  for (let m = start; m < end; m++) if (!isBlack(m)) whites.push(m);
  const wPct = 100 / whites.length;

  let whiteIdx = 0;
  for (let m = start; m < end; m++) {
    const el = document.createElement("div");
    el.dataset.midi = m;
    const label = keyForMidi(m);
    const text = label ? label.toUpperCase() : "";
    if (!isBlack(m)) {
      el.className = "key white";
      el.textContent = text;
      kb.appendChild(el);
      whiteIdx++;
    } else {
      el.className = "key black";
      el.style.left = `${whiteIdx * wPct}%`;
      el.style.width = `${wPct * 0.6}%`;
      el.textContent = text;
      kb.appendChild(el);
    }
  }
  // C labels so you can see octaves
  kb.querySelectorAll(".key.white").forEach((el) => {
    const m = +el.dataset.midi;
    if (m % 12 === 0) el.title = "C" + (Math.floor(m / 12) - 1);
  });
}

function setKeyDown(midi, down) {
  const el = kb.querySelector(`[data-midi="${midi}"]`);
  if (el) el.classList.toggle("down", down);
}

// Mouse / touch playing (pointer events, supports gliding across keys)
const pointerNotes = new Map(); // pointerId -> midi
function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.dataset && el.dataset.midi ? +el.dataset.midi : null;
}
kb.addEventListener("pointerdown", (e) => {
  const m = keyAt(e.clientX, e.clientY);
  if (m == null) return;
  kb.setPointerCapture(e.pointerId);
  pointerNotes.set(e.pointerId, m);
  noteOn(m);
});
kb.addEventListener("pointermove", (e) => {
  if (!pointerNotes.has(e.pointerId)) return;
  const m = keyAt(e.clientX, e.clientY);
  const prev = pointerNotes.get(e.pointerId);
  if (m != null && m !== prev) {
    noteOff(prev);
    pointerNotes.set(e.pointerId, m);
    noteOn(m);
  }
});
const release = (e) => {
  const m = pointerNotes.get(e.pointerId);
  if (m != null) noteOff(m);
  pointerNotes.delete(e.pointerId);
};
kb.addEventListener("pointerup", release);
kb.addEventListener("pointercancel", release);

// Computer keyboard
const heldKeys = new Map(); // key -> midi (so octave changes mid-hold don't strand notes)
window.addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target.tagName;
  if (tag === "SELECT" || (tag === "INPUT" && e.target.type === "text")) return;

  if (e.key === "ArrowLeft") return changeOctave(-1);
  if (e.key === "ArrowRight") return changeOctave(1);

  const k = e.key.toLowerCase();
  const m = midiForKey(k);
  if (m == null || heldKeys.has(k)) return;
  heldKeys.set(k, m);
  noteOn(m);
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  const m = heldKeys.get(k);
  if (m == null) return;
  heldKeys.delete(k);
  noteOff(m);
});
window.addEventListener("blur", () => { heldKeys.clear(); allNotesOff(); });
window.addEventListener("pointerdown", initAudio, { once: true });

function changeOctave(d) {
  const next = Math.max(1, Math.min(6, params.octave + d));
  if (next === params.octave) return;
  allNotesOff();
  heldKeys.clear();
  params.octave = next;
  $("oct-val").textContent = next;
  buildKeyboard();
}
$("oct-down").onclick = () => changeOctave(-1);
$("oct-up").onclick = () => changeOctave(1);

// ---------- Controls ----------
const dB = (v) => `${v > 0 ? "+" : ""}${(+v).toFixed(1)} dB`;
const fmt = {
  detune: (v) => `${v} ct`,
  detune2: (v) => `${v} ct`,
  oct2: (v) => (v > 0 ? `+${v}` : `${v}`),
  mix: (v) => `${Math.round((1 - v) * 100)}/${Math.round(v * 100)}`,
  eq1: dB, eq2: dB, eq3: dB, eq4: dB,
  attack: (v) => `${(v * 1000).toFixed(0)} ms`,
  decay: (v) => `${(v * 1000).toFixed(0)} ms`,
  sustain: (v) => `${Math.round(v * 100)}%`,
  release: (v) => `${(v * 1000).toFixed(0)} ms`,
  cutoff: (v) => { const hz = cutoffToHz(v); return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz.toFixed(0)} Hz`; },
  resonance: (v) => `Q ${(+v).toFixed(1)}`,
  volume: (v) => `${Math.round(v * 100)}%`,
};

function bindSlider(id) {
  const el = $(id);
  const out = el.parentElement.querySelector("output");
  // `initial` skips canvas drawing: the canvases are set up further down, and Boot draws them once.
  const update = (initial) => {
    params[id] = parseFloat(el.value);
    out.textContent = fmt[id](params[id]);
    applyParams();
    if (initial) return;
    if (["attack", "decay", "sustain", "release"].includes(id)) drawEnvelope();
    if (id.startsWith("eq")) drawEq();
  };
  el.addEventListener("input", () => update(false));
  el.addEventListener("change", () => el.blur()); // so keyboard notes still work after dragging
  update(true);
}
Object.keys(fmt).forEach(bindSlider);

// which = 1 or 2 (oscillator number)
function setWave(which, w) {
  const key = which === 1 ? "wave" : "wave2";
  params[key] = w;
  document.querySelectorAll(`#waves${which} button`).forEach((b) => b.classList.toggle("active", b.dataset.wave === w));
  for (const v of liveVoices) (which === 1 ? v.osc : v.osc2).type = w;
}
[1, 2].forEach((n) => {
  document.querySelectorAll(`#waves${n} button`).forEach((b) => {
    b.onclick = () => { setWave(n, b.dataset.wave); b.blur(); };
  });
});

$("eq-reset").onclick = (e) => {
  ["eq1", "eq2", "eq3", "eq4"].forEach((id) => { $(id).value = 0; $(id).dispatchEvent(new Event("input")); });
  e.target.blur();
};

// ---------- Visuals ----------
const scope = $("scope"), sctx = scope.getContext("2d");
const spec = $("spectrum"), pctx = spec.getContext("2d");
const env = $("env"), ectx = env.getContext("2d");
const eqc = $("eqcurve"), qctx = eqc.getContext("2d");

// EQ curve: combined frequency response of the 4 bands, 20 Hz .. 20 kHz, +/-15 dB
function drawEq() {
  const W = eqc.width, H = eqc.height;
  qctx.fillStyle = "#0a0b10"; qctx.fillRect(0, 0, W, H);
  const yOf = (db) => H / 2 - (db / 15) * (H / 2 - 6);
  // grid: 0 dB line and band centres
  qctx.strokeStyle = "#1e2130"; qctx.lineWidth = 1;
  qctx.beginPath(); qctx.moveTo(0, yOf(0)); qctx.lineTo(W, yOf(0)); qctx.stroke();
  const xOf = (f) => (Math.log(f / 20) / Math.log(1000)) * W;
  EQ_BANDS.forEach((b) => {
    qctx.beginPath(); qctx.moveTo(xOf(b.freq), 0); qctx.lineTo(xOf(b.freq), H); qctx.stroke();
  });

  const N = 150;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1));
  const total = new Float32Array(N).fill(1);
  if (eqNodes.length) {
    const mag = new Float32Array(N), phase = new Float32Array(N);
    eqNodes.forEach((n) => {
      n.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < N; i++) total[i] *= mag[i];
    });
  }
  qctx.beginPath();
  for (let i = 0; i < N; i++) {
    const db = 20 * Math.log10(total[i]);
    const x = (i / (N - 1)) * W, y = yOf(Math.max(-15, Math.min(15, db)));
    i ? qctx.lineTo(x, y) : qctx.moveTo(x, y);
  }
  qctx.strokeStyle = "#2ec4b6"; qctx.lineWidth = 2; qctx.stroke();
  qctx.lineTo(W, yOf(0)); qctx.lineTo(0, yOf(0));
  qctx.fillStyle = "rgba(46,196,182,0.12)"; qctx.fill();
}

function drawScope() {
  const W = scope.width, H = scope.height;
  sctx.fillStyle = "#0a0b10"; sctx.fillRect(0, 0, W, H);
  sctx.strokeStyle = "#1e2130"; sctx.lineWidth = 1;
  sctx.beginPath(); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke();

  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  // find a rising zero-crossing so the wave holds still
  let start = 0;
  for (let i = 1; i < buf.length / 2; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) { start = i; break; }
  }
  const len = 800;
  sctx.strokeStyle = "#2ec4b6"; sctx.lineWidth = 2;
  sctx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = (i / len) * W;
    const y = H / 2 - buf[start + i] * (H * 0.45);
    i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
  }
  sctx.stroke();
}

function drawSpectrum() {
  const W = spec.width, H = spec.height;
  pctx.fillStyle = "#0a0b10"; pctx.fillRect(0, 0, W, H);
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  // log-ish frequency axis: 30 Hz .. 16 kHz
  const nyq = ctx.sampleRate / 2;
  const fMin = 30, fMax = 16000;
  const bars = 120;
  const bw = W / bars;
  for (let b = 0; b < bars; b++) {
    const f0 = fMin * Math.pow(fMax / fMin, b / bars);
    const f1 = fMin * Math.pow(fMax / fMin, (b + 1) / bars);
    const i0 = Math.floor((f0 / nyq) * data.length);
    const i1 = Math.max(i0 + 1, Math.floor((f1 / nyq) * data.length));
    let peak = 0;
    for (let i = i0; i < i1; i++) peak = Math.max(peak, data[i]);
    const h = (peak / 255) * H;
    pctx.fillStyle = `hsl(${30 + (b / bars) * 150}, 85%, 55%)`;
    pctx.fillRect(b * bw, H - h, bw - 1, h);
  }
  // filter cutoff marker
  const cx = (Math.log(cutoffToHz(params.cutoff) / fMin) / Math.log(fMax / fMin)) * W;
  pctx.strokeStyle = "rgba(255,255,255,0.4)"; pctx.setLineDash([4, 4]);
  pctx.beginPath(); pctx.moveTo(cx, 0); pctx.lineTo(cx, H); pctx.stroke();
  pctx.setLineDash([]);
}

function drawEnvelope() {
  const W = env.width, H = env.height, pad = 8;
  ectx.fillStyle = "#0a0b10"; ectx.fillRect(0, 0, W, H);
  const { attack: a, decay: d, sustain: s, release: r } = params;
  const hold = 0.5; // fixed visual "key held" time for sustain segment
  const total = a + d + hold + r;
  const X = (t) => pad + (t / total) * (W - 2 * pad);
  const Y = (v) => H - pad - v * (H - 2 * pad);

  ectx.beginPath();
  ectx.moveTo(X(0), Y(0));
  ectx.lineTo(X(a), Y(1));
  // exponential decay approximated with points
  for (let i = 1; i <= 20; i++) {
    const t = a + (d * i) / 20;
    const v = s + (1 - s) * Math.exp((-3 * (i / 20)));
    ectx.lineTo(X(t), Y(v));
  }
  ectx.lineTo(X(a + d + hold), Y(s));
  for (let i = 1; i <= 20; i++) {
    const t = a + d + hold + (r * i) / 20;
    ectx.lineTo(X(t), Y(s * Math.exp(-4 * (i / 20))));
  }
  ectx.strokeStyle = "#ff9f1c"; ectx.lineWidth = 2; ectx.stroke();
  ectx.lineTo(X(total), Y(0)); ectx.lineTo(X(0), Y(0));
  ectx.fillStyle = "rgba(255,159,28,0.12)"; ectx.fill();

  // key-down / key-up markers
  ectx.strokeStyle = "#2a2d3a"; ectx.setLineDash([3, 3]);
  ectx.beginPath();
  ectx.moveTo(X(a + d + hold), 0); ectx.lineTo(X(a + d + hold), H);
  ectx.stroke(); ectx.setLineDash([]);
  ectx.fillStyle = "#7b8096"; ectx.font = "10px system-ui";
  ectx.fillText("key up", X(a + d + hold) + 4, 12);
}

function draw() {
  drawScope();
  drawSpectrum();
  requestAnimationFrame(draw);
}

// ---------- Presets (Python backend) ----------
const presetList = $("preset-list");
const PRESET_KEYS = ["wave","detune","wave2","oct2","detune2","mix","eq1","eq2","eq3","eq4",
                     "attack","decay","sustain","release","cutoff","resonance","volume"];
let presetCache = {};

async function refreshPresets() {
  try {
    presetCache = await (await fetch("/api/presets")).json();
  } catch { presetCache = {}; }
  presetList.innerHTML = "";
  const names = Object.keys(presetCache);
  if (!names.length) presetList.innerHTML = "<option value=''>(none saved yet)</option>";
  names.forEach((n) => presetList.add(new Option(n, n)));
}

function applyPreset(p) {
  PRESET_KEYS.forEach((k) => {
    if (!(k in p)) return;
    if (k === "wave") return setWave(1, p.wave);
    if (k === "wave2") return setWave(2, p.wave2);
    const el = $(k);
    el.value = p[k];
    el.dispatchEvent(new Event("input"));
  });
}

$("preset-save").onclick = async () => {
  const name = $("preset-name").value.trim();
  if (!name) return;
  const body = { name, params: Object.fromEntries(PRESET_KEYS.map((k) => [k, params[k]])) };
  await fetch("/api/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  $("preset-name").value = "";
  await refreshPresets();
  presetList.value = name;
};
$("preset-load").onclick = () => {
  const p = presetCache[presetList.value];
  if (p) applyPreset(p);
};
$("preset-del").onclick = async () => {
  const n = presetList.value;
  if (!n) return;
  await fetch("/api/presets/" + encodeURIComponent(n), { method: "DELETE" });
  refreshPresets();
};

// ---------- Boot ----------
buildKeyboard();
drawEnvelope();
drawEq();
refreshPresets();