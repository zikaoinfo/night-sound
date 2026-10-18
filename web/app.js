// app.js — UI wiring. One UI, two audio sources:
//   WebSource    — Web Audio in a browser (records while the page is open)
//   NativeSource — the SonoraRecorder plugin inside the iOS/Android app
//                  (records all night with the screen locked)
// Both produce the same event objects, so rendering doesn't care which ran.

import { RingRecorder, encodeWav } from "./recorder.js";
import { SnoreAnalyzer, CFG, computeReport } from "./analyzer.js";
import { getNativeRecorder, clipUrl } from "./native.js";

const $ = (id) => document.getElementById(id);
const COLORS = {
  quiet: "#8ecae6", light: "#4895ef", loud: "#fb8500", epic: "#ef233c", other: "#9b5de5",
};

const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
           : `${m}:${String(ss).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- sources

class WebSource {
  constructor(onChange, onLevel) {
    this.onChange = onChange;
    this.onLevel = onLevel;
    this.native = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    this.recorder = new RingRecorder(this.ctx, 20);
    this.recorder.connect(source);
    this.analyzer = new SnoreAnalyzer({
      sampleRate: this.ctx.sampleRate, fftSize: analyser.fftSize,
      recorder: this.recorder, onEvent: () => this.onChange(),
    });
    const timeData = new Float32Array(analyser.fftSize);
    const freqDb = new Float32Array(analyser.frequencyBinCount);
    this.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(timeData);
      analyser.getFloatFrequencyData(freqDb);
      const info = this.analyzer.pushFrame(this.ctx.currentTime, timeData, freqDb);
      this.onLevel({ t: info.t, db: info.db, floor: info.floor, threshold: info.threshold });
    }, CFG.frameS * 1000);
  }

  async stop() {
    clearInterval(this.timer);
    this.analyzer.flush(this.ctx.currentTime);
    this.duration = this.ctx.currentTime - (this.analyzer.startTime ?? this.ctx.currentTime);
    this.recorder.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    await this.ctx.close();
  }

  snapshot() {
    if (!this.analyzer) return null;
    const live = this.ctx && this.ctx.state !== "closed" && this.analyzer.startTime !== null;
    return {
      events: this.analyzer.events,
      envelope: this.analyzer.envelope,
      durationS: live ? this.ctx.currentTime - this.analyzer.startTime : this.duration || 0,
      noiseFloorDbfs: this.analyzer.noiseFloor,
    };
  }

  clipSrc(ev) {
    return ev.clip instanceof Float32Array
      ? URL.createObjectURL(encodeWav(ev.clip, this.analyzer.sr)) : null;
  }
}

class NativeSource {
  constructor(plugin, onChange, onLevel) {
    this.plugin = plugin;
    this.onChange = onChange;
    this.onLevel = onLevel;
    this.native = true;
    this.reset();
  }

  reset() {
    this.events = new Map();     // keyed by start time: resume can replay events
    this.savedEnvelope = [];
    this.liveEnvelope = [];
    this.durationS = 0;
    this.noiseFloor = -50;
    this.baseUrl = "";
  }

  async listen() {
    if (this.handles) return;
    this.handles = [
      await this.plugin.addListener("soundEvent", (ev) => { this.addEvent(ev); this.onChange(); }),
      await this.plugin.addListener("level", (l) => {
        this.durationS = Math.max(this.durationS, l.t);
        this.noiseFloor = l.floor;
        this.liveEnvelope.push({ t: l.t, db: l.db });
        this.onLevel(l);
      }),
    ];
  }

  async unlisten() {
    for (const h of this.handles || []) await h.remove();
    this.handles = null;
  }

  addEvent(ev) { this.events.set(ev.startS.toFixed(2), ev); }

  load(session) {
    this.events = new Map();
    session.events.forEach((e) => this.addEvent(e));
    this.savedEnvelope = session.envelope.map((db, i) => ({ t: i + 1, db }));
    this.liveEnvelope = this.liveEnvelope.filter((p) => p.t > this.savedEnvelope.length);
    this.durationS = Math.max(this.durationS, session.durationS);
    this.noiseFloor = session.noiseFloorDbfs;
    this.baseUrl = session.baseUrl;
  }

  async start(opts) {
    this.reset();
    await this.listen();
    const { sessionId } = await this.plugin.start(opts);
    this.sessionId = sessionId;
  }

  async stop() {
    const session = await this.plugin.stop();
    await this.unlisten();
    this.liveEnvelope = [];
    this.load(session);
  }

  // After the app comes back to the foreground (or relaunches mid-night),
  // pick up whatever the plugin recorded while the web view was asleep.
  async resume() {
    const st = await this.plugin.status();
    if (!st.recording) return false;
    await this.listen();
    this.sessionId = st.sessionId;
    this.load(await this.plugin.getSession({ id: st.sessionId }));
    this.durationS = Math.max(this.durationS, st.elapsedS);
    return true;
  }

  snapshot() {
    return {
      events: [...this.events.values()].sort((a, b) => a.startS - b.startS),
      envelope: this.savedEnvelope.concat(this.liveEnvelope),
      durationS: this.durationS,
      noiseFloorDbfs: this.noiseFloor,
    };
  }

  clipSrc(ev) {
    return typeof ev.clip === "string" && this.baseUrl ? clipUrl(this.baseUrl, ev.clip) : null;
  }
}

// ---------------------------------------------------------------- state

let source = null;
let running = false;
let uiTimer = null;
let wakeLock = null;

async function makeSource() {
  const native = await getNativeRecorder();
  return native
    ? new NativeSource(native.plugin, () => renderEvents(), updateMeter)
    : new WebSource(() => renderEvents(), updateMeter);
}

async function start() {
  $("note").textContent = "";
  try {
    source = await makeSource();
    await source.start({ sensitivity: "normal" });
  } catch (err) {
    $("note").textContent = source && source.native
      ? "Couldn't start: " + (err.message || err)
      : "Microphone blocked: " + (err.message || err) +
        ". The page needs HTTPS (or localhost) and mic permission.";
    return;
  }
  setRunning(true);
  if (!source.native) await requestWakeLock();
}

async function stop() {
  setRunning(false);
  try { await source.stop(); } catch (err) { $("note").textContent = "Stop failed: " + (err.message || err); }
  await releaseWakeLock();
  render();
  $("scoreSub").textContent = "Session finished. Review your sounds below or export.";
}

function setRunning(on) {
  running = on;
  clearInterval(uiTimer);
  if (on) uiTimer = setInterval(render, 1000);
  $("btnStart").hidden = on;
  $("btnStop").hidden = !on;
  $("btnExport").hidden = false;
  $("intensity").hidden = false;
  $("liveState").textContent = on ? "listening" : "stopped";
  $("liveState").className = on ? "rec" : "dot-idle";
  if (on) {
    $("scoreSub").textContent = source.native
      ? "Listening. You can lock the screen — Sonora keeps recording."
      : "Listening… keep the screen on (plug in for a full night).";
  }
}

// ---------------------------------------------------------------- render

function currentReport() {
  const snap = source && source.snapshot();
  return snap ? { snap, report: computeReport(snap) } : null;
}

function render() {
  const cur = currentReport();
  if (!cur) return;
  const r = cur.report;
  $("scoreVal").textContent = Math.round(r.snoreScore);
  $("statTime").textContent = fmt(r.snoreTimeS);
  $("statPct").textContent = r.snorePercent.toFixed(0) + "%";
  $("statEvents").textContent = r.snoreEvents;
  $("statEpisodes").textContent = r.episodes.length;
  $("iQuiet").textContent = r.intensityCounts.quiet;
  $("iLight").textContent = r.intensityCounts.light;
  $("iLoud").textContent = r.intensityCounts.loud;
  $("iEpic").textContent = r.intensityCounts.epic;
  if (!running) $("liveClock").textContent = fmt(r.durationS);
  drawTimeline(cur.snap, r);
}

function updateMeter(info) {
  const bottom = (info.floor || -60) - 5, top = 0;
  const pct = Math.max(0, Math.min(100, ((info.db - bottom) / (top - bottom)) * 100));
  $("meterFill").style.width = pct + "%";
  const tp = Math.max(0, Math.min(100, ((info.threshold - bottom) / (top - bottom)) * 100));
  $("meterThresh").style.left = tp + "%";
  $("liveFloor").textContent = "floor " + info.floor.toFixed(0) + " dB";
  $("liveClock").textContent = fmt(info.t);
}

function drawTimeline(snap, r) {
  const cv = $("timeline");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const dur = Math.max(r.durationS, 1);
  const floor = r.noiseFloorDbfs || -55;
  const bottom = floor - 10, top = 0;
  const yOf = (db) => h - Math.max(0, Math.min(1, (db - bottom) / (top - bottom))) * (h - 10) - 5;

  ctx.strokeStyle = getToken("--line"); ctx.lineWidth = 1;
  ctx.beginPath(); const ty = yOf(floor + CFG.threshOverFloorDb);
  ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();

  const env = snap.envelope;
  if (env.length > 1) {
    ctx.strokeStyle = getToken("--muted"); ctx.globalAlpha = 0.5; ctx.beginPath();
    const step = Math.max(1, Math.floor(env.length / w));
    for (let i = 0, first = true; i < env.length; i += step) {
      const x = (env[i].t / dur) * w, y = yOf(env[i].db);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  for (const e of snap.events) {
    const x0 = (e.startS / dur) * w, x1 = Math.max(x0 + 2, (e.endS / dur) * w);
    if (e.confirmedSnore) {
      ctx.fillStyle = COLORS[e.intensity] || COLORS.light;
      ctx.fillRect(x0, 8, x1 - x0, h - 24);
    } else if (e.intensity === "loud" || e.intensity === "epic") {
      ctx.fillStyle = COLORS.other;
      ctx.beginPath(); ctx.moveTo(x0, h - 4); ctx.lineTo(x0 - 4, h - 12); ctx.lineTo(x0 + 4, h - 12);
      ctx.closePath(); ctx.fill();
    }
  }
}

function getToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function renderEvents() {
  const ul = $("eventList");
  const snap = source && source.snapshot();
  if (snap) computeReport(snap);              // sets confirmedSnore on each event
  const recent = snap ? snap.events.slice(-30).reverse() : [];
  if (!recent.length) { ul.innerHTML = '<li class="empty">No sounds yet.</li>'; return; }
  ul.innerHTML = "";
  for (const e of recent) {
    const li = document.createElement("li");
    const badge = e.confirmedSnore ? "snore" : "other";
    li.innerHTML =
      `<span class="ev-time">${fmt(e.startS)}</span>` +
      `<span class="ev-badge ${badge}">${badge}</span>` +
      `<span class="ev-meta">${e.intensity} · ${e.durationS.toFixed(1)}s · ${e.peakDbfs.toFixed(0)}dB` +
      (e.f0 ? ` · ${e.f0.toFixed(0)}Hz` : "") + `</span>`;
    if (e.clip) {
      const btn = document.createElement("button");
      btn.className = "ev-play"; btn.textContent = "▶";
      btn.setAttribute("aria-label", "Play this sound");
      btn.onclick = () => playClip(e);
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function playClip(e) {
  const src = source.clipSrc(e);
  if (!src) return;
  const a = new Audio(src);
  a.play().catch((err) => { $("note").textContent = "Couldn't play that clip: " + err.message; });
  if (src.startsWith("blob:")) a.onended = () => URL.revokeObjectURL(src);
}

function exportJson() {
  const cur = currentReport();
  if (!cur) return;
  const events = cur.snap.events.map(({ clip, ...rest }) =>
    (typeof clip === "string" ? { ...rest, clip } : rest));
  const blob = new Blob([JSON.stringify(
    { ...cur.report, generatedAt: new Date().toISOString(), events }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "sonora-session.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- wake lock / resume

async function requestWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); }
  catch (_) {}
}
async function releaseWakeLock() {
  try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (_) {}
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !running) return;
  if (source.native) { await source.resume(); render(); renderEvents(); }
  else requestWakeLock();
});

// If the app was closed mid-night, reattach to the running native session.
(async () => {
  const native = await getNativeRecorder();
  if (!native) return;
  const s = new NativeSource(native.plugin, () => renderEvents(), updateMeter);
  if (await s.resume()) {
    source = s;
    setRunning(true);
    render(); renderEvents();
  }
})();

$("btnStart").addEventListener("click", start);
$("btnStop").addEventListener("click", stop);
$("btnExport").addEventListener("click", exportJson);

$("note").textContent =
  "Tip: keep the phone near the bed and plugged in. In the Sonora app you can lock the screen; " +
  "in a browser the screen has to stay on. Nothing is uploaded.";
