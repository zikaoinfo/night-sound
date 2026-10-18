// app.js — UI wiring. One UI, two audio sources:
//   WebSource    — Web Audio in a browser (records while the page is open)
//   NativeSource — the SonoraRecorder plugin inside the iOS/Android app
//                  (records all night with the screen locked)
// Both produce the same event objects. The Tonight tab shows either the live
// session or a saved night; the History tab lists saved nights.

import { RingRecorder, encodeWav } from "./recorder.js";
import { SnoreAnalyzer, CFG, computeReport } from "./analyzer.js";
import { getNativeRecorder, platform, clipUrl } from "./native.js";
import { listNights, loadNight, deleteNight, saveWebNight } from "./history.js";

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

// "7 h 42 min", "42 min", "35 s"
const fmtDur = (s) => {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

const fmtNight = (iso) => new Date(iso).toLocaleString(undefined,
  { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

// ---------------------------------------------------------------- settings

const SETTINGS_KEY = "sonora:settings";
function loadSettings() {
  try { return { sensitivity: "normal", fullRecording: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) }; }
  catch (_) { return { sensitivity: "normal", fullRecording: false }; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
}
const settings = loadSettings();

// ---------------------------------------------------------------- sources

class WebSource {
  constructor(onChange, onLevel) {
    this.onChange = onChange;
    this.onLevel = onLevel;
    this.native = false;
  }

  async start(opts) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.startedAt = new Date();
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
      sampleRate: this.ctx.sampleRate, fftSize: analyser.fftSize, recorder: this.recorder,
      sensitivity: opts.sensitivity, onEvent: () => this.onChange(),
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
    await saveWebNight(this.snapshot(), this.startedAt);
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

let source = null;     // the live (or last) recording
let stored = null;     // a saved night being viewed: { id, startedAt, snap, clipSrc }
let running = false;
let uiTimer = null;
let wakeLock = null;

// What the Tonight tab is showing right now.
function current() {
  if (stored) return { snap: stored.snap, clipSrc: stored.clipSrc };
  const snap = source && source.snapshot();
  return snap ? { snap, clipSrc: (ev) => source.clipSrc(ev) } : null;
}

async function makeSource() {
  const native = await getNativeRecorder();
  return native
    ? new NativeSource(native.plugin, () => renderEvents(), updateMeter)
    : new WebSource(() => renderEvents(), updateMeter);
}

async function start() {
  closeStored();
  $("note").textContent = "";
  try {
    source = await makeSource();
    await source.start({ sensitivity: settings.sensitivity, fullRecording: settings.fullRecording });
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
  renderEvents();
  refreshHistory();
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
  document.querySelectorAll("#settings input").forEach((i) => (i.disabled = on));
  $("settingsHint").textContent = on ? "Settings are locked while recording." : "Changes apply from the next session.";
  if (on) {
    $("scoreSub").textContent = source.native
      ? "Listening. You can lock the screen — Sonora keeps recording."
      : "Listening… keep the screen on (plug in for a full night).";
  }
}

// ---------------------------------------------------------------- morning summary

function summaryText(r) {
  const others = r.weirdSounds.length
    ? ` ${r.weirdSounds.length} other loud sound${r.weirdSounds.length > 1 ? "s" : ""} worth a listen.` : "";
  if (!r.snoreEvents) return `No snoring detected in ${fmtDur(r.durationS)}.${others}`;
  const mostly = Object.entries(r.intensityCounts).sort((a, b) => b[1] - a[1])[0][0];
  const eps = r.episodes.length;
  return `You snored for ${fmtDur(r.snoreTimeS)} (${r.snorePercent.toFixed(0)}% of ${fmtDur(r.durationS)})` +
    (eps ? ` in ${eps} episode${eps > 1 ? "s" : ""}` : "") + `, mostly ${mostly}.${others}`;
}

// ---------------------------------------------------------------- render: tonight

function render() {
  const cur = current();
  if (!cur) return;
  const r = computeReport(cur.snap);
  $("scoreVal").textContent = Math.round(r.snoreScore);
  $("statTime").textContent = fmt(r.snoreTimeS);
  $("statPct").textContent = r.snorePercent.toFixed(0) + "%";
  $("statEvents").textContent = r.snoreEvents;
  $("statEpisodes").textContent = r.episodes.length;
  $("iQuiet").textContent = r.intensityCounts.quiet;
  $("iLight").textContent = r.intensityCounts.light;
  $("iLoud").textContent = r.intensityCounts.loud;
  $("iEpic").textContent = r.intensityCounts.epic;
  $("intensity").hidden = false;
  if (!running || stored) {
    $("liveClock").textContent = fmt(r.durationS);
    $("scoreSub").textContent = summaryText(r);
  }
  drawTimeline(cur.snap, r);
}

function updateMeter(info) {
  if (stored) return;
  const bottom = (info.floor || -60) - 5, top = 0;
  const pct = Math.max(0, Math.min(100, ((info.db - bottom) / (top - bottom)) * 100));
  $("meterFill").style.width = pct + "%";
  const tp = Math.max(0, Math.min(100, ((info.threshold - bottom) / (top - bottom)) * 100));
  $("meterThresh").style.left = tp + "%";
  $("liveFloor").textContent = "floor " + info.floor.toFixed(0) + " dB";
  $("liveClock").textContent = fmt(info.t);
}

function getToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function sizeCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawTimeline(snap, r) {
  const { ctx, w, h } = sizeCanvas($("timeline"));
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

function renderEvents() {
  const ul = $("eventList");
  const cur = current();
  if (cur) computeReport(cur.snap);            // sets confirmedSnore on each event
  const all = cur ? cur.snap.events : [];
  // Live: the latest 30. A saved night: the notable ones first (all snores
  // would be hundreds), then the rest up to 60.
  const list = stored
    ? [...all].filter((e) => e.clip || e.confirmedSnore || e.intensity !== "quiet")
        .sort((a, b) => b.peakDbfs - a.peakDbfs).slice(0, 60).sort((a, b) => a.startS - b.startS)
    : all.slice(-30).reverse();
  if (!list.length) { ul.innerHTML = '<li class="empty">No sounds yet.</li>'; return; }
  ul.innerHTML = "";
  for (const e of list) {
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
      btn.setAttribute("aria-label", `Play the ${badge} at ${fmt(e.startS)}`);
      btn.onclick = () => playClip(cur.clipSrc(e));
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function playClip(src) {
  if (!src) return;
  const a = new Audio(src);
  if (src.startsWith("blob:")) a.onended = () => URL.revokeObjectURL(src);
  a.play().catch((err) => { $("note").textContent = "Couldn't play that clip: " + err.message; });
}

function exportJson() {
  const cur = current();
  if (!cur) return;
  const report = computeReport(cur.snap);
  const events = cur.snap.events.map(({ clip, ...rest }) =>
    (typeof clip === "string" ? { ...rest, clip } : rest));
  const blob = new Blob([JSON.stringify(
    { ...report, generatedAt: new Date().toISOString(), events }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = stored ? `sonora-${stored.id}.json` : "sonora-session.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- viewing a saved night

async function openNight(id) {
  try {
    stored = await loadNight(id);
  } catch (err) {
    $("note").textContent = "Couldn't open that night: " + (err.message || err);
    return;
  }
  $("viewingLabel").textContent = "Night of " + fmtNight(stored.startedAt);
  $("viewingBar").hidden = false;
  $("confirmDelete").hidden = true;
  $("controls").hidden = false;
  $("btnStart").hidden = true;
  $("btnStop").hidden = true;
  $("btnExport").hidden = false;
  $("live").hidden = true;
  showTab("tonight");
  render();
  renderEvents();
}

function closeStored() {
  stored = null;
  $("viewingBar").hidden = true;
  $("confirmDelete").hidden = true;
  $("live").hidden = false;
  $("btnStart").hidden = running;
  $("btnStop").hidden = !running;
}

function backToTonight() {
  closeStored();
  if (source) { render(); renderEvents(); }
  else {
    $("scoreVal").textContent = "—";
    $("scoreSub").textContent = "Press start to begin listening";
    $("intensity").hidden = true;
    $("btnExport").hidden = true;
    $("statTime").textContent = "0:00";
    $("statPct").textContent = "0%";
    $("statEvents").textContent = "0";
    $("statEpisodes").textContent = "0";
    $("liveClock").textContent = "0:00";
    sizeCanvas($("timeline"));
    renderEvents();
  }
}

async function confirmDeleteNight() {
  const id = stored.id;
  try { await deleteNight(id); } catch (err) {
    $("note").textContent = "Couldn't delete: " + (err.message || err);
    return;
  }
  backToTonight();
  await refreshHistory();
  showTab("history");
}

// ---------------------------------------------------------------- history tab

let nights = [];

async function refreshHistory() {
  try { nights = await listNights(); } catch (_) { nights = []; }
  // Hide the session still being recorded; it shows on the Tonight tab.
  const live = running && source && source.sessionId;
  nights = nights.filter((n) => n.id !== live);
  renderNightList();
  drawTrend();
}

function renderNightList() {
  const ul = $("nightList");
  if (!nights.length) {
    ul.innerHTML = '<li class="empty">No nights saved yet. Record one from the Tonight tab.</li>';
    return;
  }
  ul.innerHTML = "";
  for (const n of nights) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "night";
    const unfinished = !n.endedAt ? " · stopped early" : "";
    b.innerHTML =
      `<span class="night-date">${fmtNight(n.startedAt)}</span>` +
      `<span class="night-score">${Math.round(n.snoreScore)}<small>/100</small></span>` +
      `<span class="night-meta">${fmtDur(n.durationS)} · snoring ${n.snorePercent.toFixed(0)}% · ` +
      `${n.episodes} episode${n.episodes === 1 ? "" : "s"}${unfinished}</span>`;
    b.setAttribute("aria-label", `Open the night of ${fmtNight(n.startedAt)}, score ${Math.round(n.snoreScore)}`);
    b.onclick = () => openNight(n.id);
    li.appendChild(b);
    ul.appendChild(li);
  }
}

// Bars: Snore Score of the last 14 nights, oldest on the left.
function drawTrend() {
  const cv = $("trend");
  if (cv.closest("[hidden]")) return;          // not visible: no size to draw at
  const { ctx, w, h } = sizeCanvas(cv);
  const data = nights.slice(0, 14).reverse();
  const padL = 30, padR = 8, padT = 10, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const y = (v) => padT + plotH * (1 - v / 100);

  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = getToken("--muted");
  ctx.strokeStyle = getToken("--line");
  ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const v of [0, 50, 100]) {
    ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(w - padR, y(v)); ctx.stroke();
    ctx.fillText(String(v), padL - 6, y(v));
  }
  cv.setAttribute("aria-label", data.length
    ? "Snore Score for recent nights: " + data.map((n) => `${fmtNight(n.startedAt)} ${Math.round(n.snoreScore)}`).join(", ")
    : "No nights saved yet");
  if (!data.length) return;

  const slot = plotW / data.length;
  const barW = Math.min(28, slot * 0.6);
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  data.forEach((n, i) => {
    const cx = padL + slot * (i + 0.5);
    const v = Math.max(1, n.snoreScore);
    ctx.fillStyle = i === data.length - 1 ? getToken("--accent") : getToken("--light");
    ctx.globalAlpha = i === data.length - 1 ? 1 : 0.75;
    ctx.fillRect(cx - barW / 2, y(v), barW, y(0) - y(v));
    ctx.globalAlpha = 1;
    if (data.length <= 7 || (data.length - 1 - i) % 2 === 0) {   // every other, ending on the latest
      ctx.fillStyle = getToken("--muted");
      const d = new Date(n.startedAt);
      ctx.fillText(`${d.getDate()}/${d.getMonth() + 1}`, cx, h - padB + 6);
    }
  });
  cv.onclick = (e) => {
    const rect = cv.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - padL) / slot);
    if (i >= 0 && i < data.length) openNight(data[i].id);
  };
}

// ---------------------------------------------------------------- tabs

function showTab(name) {
  const tonight = name === "tonight";
  $("tabTonight").setAttribute("aria-selected", String(tonight));
  $("tabHistory").setAttribute("aria-selected", String(!tonight));
  $("viewTonight").hidden = !tonight;
  $("viewHistory").hidden = tonight;
  if (!tonight) refreshHistory();
  else if (current()) render();
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

// ---------------------------------------------------------------- boot

function initSettings() {
  const radio = $({ low: "sensLow", normal: "sensNormal", high: "sensHigh" }[settings.sensitivity] || "sensNormal");
  radio.checked = true;
  document.querySelectorAll('input[name="sens"]').forEach((r) =>
    r.addEventListener("change", () => { settings.sensitivity = r.value; saveSettings(); }));
  $("optFull").checked = settings.fullRecording;
  $("optFull").addEventListener("change", () => { settings.fullRecording = $("optFull").checked; saveSettings(); });
  // Full-night audio is recorded by the iOS plugin only.
  platform().then((p) => { $("fullRow").hidden = p !== "ios"; });
}

$("btnStart").addEventListener("click", start);
$("btnStop").addEventListener("click", stop);
$("btnExport").addEventListener("click", exportJson);
$("btnBack").addEventListener("click", backToTonight);
$("btnDelete").addEventListener("click", () => { $("confirmDelete").hidden = false; });
$("btnDeleteCancel").addEventListener("click", () => { $("confirmDelete").hidden = true; });
$("btnDeleteConfirm").addEventListener("click", confirmDeleteNight);
$("tabTonight").addEventListener("click", () => showTab("tonight"));
$("tabHistory").addEventListener("click", () => showTab("history"));
window.addEventListener("resize", () => { if (!$("viewHistory").hidden) drawTrend(); else render(); });

initSettings();
$("note").textContent =
  "Tip: keep the phone near the bed and plugged in. In the Sonora app you can lock the screen; " +
  "in a browser the screen has to stay on. Nothing is uploaded.";

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
