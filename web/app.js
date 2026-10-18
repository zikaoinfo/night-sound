// app.js — UI wiring: mic capture, the frame loop, live display, timeline,
// event list with playback, export. All on-device.

import { RingRecorder, encodeWav } from "./recorder.js";
import { SnoreAnalyzer, CFG } from "./analyzer.js";

const $ = (id) => document.getElementById(id);
const COLORS = {
  quiet: "#8ecae6", light: "#4895ef", loud: "#fb8500", epic: "#ef233c", other: "#9b5de5",
};

let audioCtx, analyser, stream, recorder, analyzer, source;
let frameTimer = null, uiTimer = null, wakeLock = null;
let running = false;

const fmt = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
           : `${m}:${String(ss).padStart(2, "0")}`;
};

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    $("note").textContent =
      "Microphone blocked: " + err.message +
      ". The page needs HTTPS (or localhost) and mic permission.";
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  source = audioCtx.createMediaStreamSource(stream);

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  recorder = new RingRecorder(audioCtx, 20);
  recorder.connect(source);

  analyzer = new SnoreAnalyzer({
    sampleRate: audioCtx.sampleRate,
    fftSize: analyser.fftSize,
    recorder,
    onEvent: () => renderEvents(),
  });

  const timeData = new Float32Array(analyser.fftSize);
  const freqDb = new Float32Array(analyser.frequencyBinCount);

  frameTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(timeData);
    analyser.getFloatFrequencyData(freqDb);
    const info = analyzer.pushFrame(audioCtx.currentTime, timeData, freqDb);
    updateMeter(info);
  }, CFG.frameS * 1000);

  uiTimer = setInterval(updateUI, 1000);

  await requestWakeLock();
  document.addEventListener("visibilitychange", onVisibility);

  running = true;
  $("btnStart").hidden = true;
  $("btnStop").hidden = false;
  $("btnExport").hidden = false;
  $("intensity").hidden = false;
  $("liveState").textContent = "listening";
  $("liveState").className = "rec";
  $("scoreSub").textContent = "Listening… keep the screen on (plug in for a full night).";
}

async function stop() {
  running = false;
  clearInterval(frameTimer); clearInterval(uiTimer);
  if (analyzer && audioCtx) analyzer.flush(audioCtx.currentTime);
  document.removeEventListener("visibilitychange", onVisibility);
  await releaseWakeLock();
  if (recorder) recorder.disconnect();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) await audioCtx.close();
  updateUI();
  renderEvents();
  $("btnStart").hidden = false;
  $("btnStop").hidden = true;
  $("liveState").textContent = "stopped";
  $("liveState").className = "dot-idle";
  $("scoreSub").textContent = "Session finished. Review your sounds below or export.";
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

function updateUI() {
  if (!analyzer || !audioCtx) return;
  const r = analyzer.report(audioCtx.currentTime);
  $("scoreVal").textContent = Math.round(r.snoreScore);
  $("statTime").textContent = fmt(r.snoreTimeS);
  $("statPct").textContent = r.snorePercent.toFixed(0) + "%";
  $("statEvents").textContent = r.snoreEvents;
  $("statEpisodes").textContent = r.episodes.length;
  $("iQuiet").textContent = r.intensityCounts.quiet;
  $("iLight").textContent = r.intensityCounts.light;
  $("iLoud").textContent = r.intensityCounts.loud;
  $("iEpic").textContent = r.intensityCounts.epic;
  drawTimeline(r);
  try { localStorage.setItem("nightsound:last", JSON.stringify(stripReport(r))); } catch (_) {}
}

function drawTimeline(r) {
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

  // threshold guide
  ctx.strokeStyle = getToken("--line"); ctx.lineWidth = 1;
  ctx.beginPath(); const ty = yOf(floor + CFG.threshOverFloorDb);
  ctx.moveTo(0, ty); ctx.lineTo(w, ty); ctx.stroke();

  // envelope
  const env = analyzer.envelope;
  if (env.length > 1) {
    ctx.strokeStyle = getToken("--muted"); ctx.globalAlpha = 0.5; ctx.beginPath();
    const step = Math.max(1, Math.floor(env.length / w));
    for (let i = 0, first = true; i < env.length; i += step) {
      const x = (env[i].t / dur) * w, y = yOf(env[i].db);
      first ? (ctx.moveTo(x, y), first = false) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  // events
  for (const e of analyzer.events) {
    const x0 = (e.startS / dur) * w, x1 = Math.max(x0 + 2, (e.endS / dur) * w);
    if (e.isSnore) {
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
  const recent = analyzer.events.slice(-30).reverse();
  if (!recent.length) { ul.innerHTML = '<li class="empty">No sounds yet.</li>'; return; }
  ul.innerHTML = "";
  for (const e of recent) {
    const li = document.createElement("li");
    const badge = e.isSnore ? "snore" : "other";
    li.innerHTML =
      `<span class="ev-time">${fmt(e.startS)}</span>` +
      `<span class="ev-badge ${badge}">${badge}</span>` +
      `<span class="ev-meta">${e.intensity} · ${e.durationS.toFixed(1)}s · ${e.peakDbfs.toFixed(0)}dB` +
      (e.f0 ? ` · ${e.f0.toFixed(0)}Hz` : "") + `</span>`;
    if (e.clip) {
      const btn = document.createElement("button");
      btn.className = "ev-play"; btn.textContent = "▶";
      btn.onclick = () => playClip(e);
      li.appendChild(btn);
    }
    ul.appendChild(li);
  }
}

function playClip(e) {
  if (!e.clip) return;
  const blob = encodeWav(e.clip, analyzer.sr);
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  a.play();
  a.onended = () => URL.revokeObjectURL(url);
}

function stripReport(r) {
  return { ...r, generatedAt: new Date().toISOString() };
}

function exportJson() {
  const r = analyzer.report(audioCtx ? audioCtx.currentTime : (analyzer.startTime || 0));
  const events = analyzer.events.map(({ clip, ...rest }) => rest);
  const blob = new Blob([JSON.stringify({ ...stripReport(r), events }, null, 2)],
    { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "night-sound-session.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function requestWakeLock() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); }
  catch (_) {}
}
async function releaseWakeLock() {
  try { if (wakeLock) { await wakeLock.release(); wakeLock = null; } } catch (_) {}
}
function onVisibility() {
  if (document.visibilityState === "visible" && running) requestWakeLock();
}

$("btnStart").addEventListener("click", start);
$("btnStop").addEventListener("click", stop);
$("btnExport").addEventListener("click", exportJson);

$("note").textContent =
  "Tip: keep the screen on and the phone plugged in near the bed. Pure web pauses the mic when the " +
  "screen sleeps — the native (app-store) build records all night in the background. Nothing is uploaded.";
