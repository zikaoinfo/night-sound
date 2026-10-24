// report.js — a one-night PDF report you can share with a doctor or partner,
// sent together with the loudest audio clips. Built entirely on the device.
//
// vendor/jspdf.umd.min.js is jsPDF 4.2.1 (MIT), copied in because the web app
// has no bundler.

import { computeReport } from "./analyzer.js";
import { labelOf } from "./tags.js";
import { shareFiles } from "./share.js";

const MAX_CLIPS = 6;

let jsPdfPromise = null;
function loadJsPdf() {
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL("./vendor/jspdf.umd.min.js", import.meta.url).href;
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => reject(new Error("couldn't load the PDF library"));
      document.head.appendChild(s);
    });
  }
  return jsPdfPromise;
}

const hms = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
const dur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};
// Clock time of a moment `t` seconds into a night that started at `start`.
const clock = (start, t) => new Date(start.getTime() + t * 1000)
  .toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const INK = { quiet: "#5fa8d3", light: "#2f6fd6", loud: "#e07a00", epic: "#c81d3a", other: "#7b4fc9" };

// A light, printable timeline drawn on its own canvas.
function timelineImage(snap, report, start) {
  const W = 1600, H = 320, padB = 40;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, W, H);
  const d = Math.max(report.durationS, 1);
  const floor = report.noiseFloorDbfs || -55;
  const lo = floor - 10, plotH = H - padB;
  const y = (db) => plotH - Math.max(0, Math.min(1, (db - lo) / (0 - lo))) * (plotH - 10) - 5;

  g.strokeStyle = "#9aa3b2"; g.lineWidth = 2; g.beginPath();
  const env = snap.envelope, step = Math.max(1, Math.floor(env.length / W));
  for (let i = 0, first = true; i < env.length; i += step) {
    const x = (env[i].t / d) * W;
    first ? (g.moveTo(x, y(env[i].db)), first = false) : g.lineTo(x, y(env[i].db));
  }
  g.stroke();

  for (const e of snap.events) {
    const x0 = (e.startS / d) * W, x1 = Math.max(x0 + 3, (e.endS / d) * W);
    if (e.confirmedSnore) { g.fillStyle = INK[e.intensity] || INK.light; g.fillRect(x0, 10, x1 - x0, plotH - 30); }
    else if (e.intensity === "loud" || e.intensity === "epic") {
      g.fillStyle = INK.other; g.beginPath();
      g.moveTo(x0, plotH - 4); g.lineTo(x0 - 8, plotH - 20); g.lineTo(x0 + 8, plotH - 20); g.closePath(); g.fill();
    }
  }

  g.fillStyle = "#4a5263"; g.font = "24px sans-serif"; g.textAlign = "center"; g.textBaseline = "top";
  g.strokeStyle = "#d5dae3"; g.beginPath(); g.moveTo(0, plotH); g.lineTo(W, plotH); g.stroke();
  const hours = d / 3600, every = hours > 6 ? 2 : 1;
  for (let h = 0; h <= hours; h += every) {
    const x = Math.min(W - 40, Math.max(40, (h * 3600 / d) * W));
    g.fillText(clock(start, h * 3600), x, plotH + 8);
  }
  return c.toDataURL("image/png");
}

// Loudest confirmed snores and loudest other sounds that have a clip.
export function pickClips(events) {
  const withClip = events.filter((e) => e.clip);
  const byPeak = (a, b) => b.peakDbfs - a.peakDbfs;
  const snores = withClip.filter((e) => e.confirmedSnore).sort(byPeak).slice(0, MAX_CLIPS - 2);
  const others = withClip.filter((e) => !e.confirmedSnore).sort(byPeak).slice(0, MAX_CLIPS - snores.length);
  return [...snores, ...others].sort((a, b) => a.startS - b.startS);
}

const clipName = (e, i) =>
  `sonora-${String(i + 1).padStart(2, "0")}-${e.confirmedSnore ? "snore" : "sound"}-${hms(e.startS).replace(/:/g, "-")}.wav`;

export async function buildReportPdf({ snap, startedAt, meta }, clips = []) {
  const JsPDF = await loadJsPdf();
  const r = computeReport(snap);
  const start = new Date(startedAt);
  const doc = new JsPDF({ unit: "mm", format: "a4" });
  const L = 16, Wd = 178;
  let y = 18;

  doc.setFont("helvetica", "bold"); doc.setFontSize(18);
  doc.text("Sonora - sleep sound report", L, y); y += 8;
  doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(80);
  const end = new Date(start.getTime() + r.durationS * 1000);
  doc.text(`Night of ${start.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ` +
           `${clock(start, 0)} - ${clock(end, 0)} (${dur(r.durationS)} recorded)`, L, y);
  y += 10; doc.setTextColor(0);

  const tiles = [
    ["Snore Score", `${Math.round(r.snoreScore)} / 100`],
    ["Time snoring", `${dur(r.snoreTimeS)} (${r.snorePercent.toFixed(0)}%)`],
    ["Snores per hour", r.snoresPerHour.toFixed(0)],
    ["Episodes", String(r.episodes.length)],
  ];
  const tw = Wd / tiles.length;
  tiles.forEach(([k, v], i) => {
    const x = L + i * tw;
    doc.setDrawColor(210); doc.roundedRect(x, y, tw - 3, 18, 2, 2);
    doc.setFontSize(9); doc.setTextColor(100); doc.text(k, x + 3, y + 6);
    doc.setFontSize(13); doc.setTextColor(0); doc.setFont("helvetica", "bold"); doc.text(v, x + 3, y + 14);
    doc.setFont("helvetica", "normal");
  });
  y += 24;

  doc.setFontSize(10);
  const ic = r.intensityCounts;
  doc.text(`Snore loudness: ${ic.quiet} quiet, ${ic.light} light, ${ic.loud} loud, ${ic.epic} epic. ` +
           `Other loud sounds: ${r.weirdSounds.length}. Room noise floor: ${Math.round(r.noiseFloorDbfs)} dBFS.`, L, y, { maxWidth: Wd });
  y += 8;

  doc.addImage(timelineImage(snap, r, start), "PNG", L, y, Wd, Wd * 320 / 1600);
  y += Wd * 320 / 1600 + 3;
  doc.setFontSize(8); doc.setTextColor(100);
  doc.text("Timeline: grey line = room loudness; bars = snoring (light blue quiet, blue light, orange loud, red epic); " +
           "purple marks = other loud sounds.", L, y, { maxWidth: Wd });
  y += 9; doc.setTextColor(0);

  const section = (title) => {
    if (y > 260) { doc.addPage(); y = 18; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.text(title, L, y); y += 6;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  };
  const line = (text) => {
    const lines = doc.splitTextToSize(text, Wd);
    if (y + lines.length * 5 > 285) { doc.addPage(); y = 18; }
    doc.text(lines, L, y); y += lines.length * 5;
  };

  const m = meta || {};
  if ((m.tags && m.tags.length) || m.rating || m.note) {
    section("Before bed and in the morning");
    if (m.tags && m.tags.length) line("Factors and remedies: " + m.tags.map(labelOf).join(", "));
    if (m.rating) line(`How rested (1-5): ${m.rating}`);
    if (m.note) line("Note: " + m.note);
    y += 3;
  }

  section("Snoring episodes");
  if (!r.episodes.length) line("No rhythmic snoring episodes.");
  for (const ep of r.episodes.slice(0, 15)) {
    line(`${clock(start, ep.startS)} - ${clock(start, ep.endS)}   ${dur(ep.endS - ep.startS)}, ` +
         `${ep.snores} snores, one every ${ep.meanIntervalS.toFixed(1)} s`);
  }
  if (r.episodes.length > 15) line(`... and ${r.episodes.length - 15} more.`);
  y += 3;

  section("Other loud sounds");
  if (!r.weirdSounds.length) line("None.");
  const others = snap.events.filter((e) => !e.confirmedSnore && (e.intensity === "loud" || e.intensity === "epic"));
  for (const e of others.slice(0, 12)) {
    line(`${clock(start, e.startS)}   ${e.durationS.toFixed(1)} s, ${Math.round(e.peakDbfs)} dBFS` +
         (e.sound ? `, sounds like: ${e.sound}` : ""));
  }
  if (others.length > 12) line(`... and ${others.length - 12} more.`);
  y += 3;

  if (clips.length) {
    section("Audio clips sent with this report");
    clips.forEach((e, i) => line(`${clipName(e, i)}  (${clock(start, e.startS)}, ${e.confirmedSnore ? "snore" : "other sound"})`));
    y += 3;
  }

  if (y > 270) { doc.addPage(); y = 18; }
  doc.setFontSize(8); doc.setTextColor(110);
  line("Recorded and analysed on the phone by Sonora; nothing was uploaded. Sonora is not a medical device and " +
       "does not diagnose sleep apnoea or any other condition. Loudness is relative to the phone's microphone, " +
       "not a calibrated sound level.");
  return doc.output("blob");
}

// Build the PDF plus clips and hand them to the system share sheet.
// Returns a sentence describing what happened.
export async function shareReport(night, clipBlob) {
  const clips = pickClips(night.snap.events);
  const files = [];
  for (const [i, e] of clips.entries()) {
    try {
      const blob = await clipBlob(e);
      if (blob) files.push({ name: clipName(e, i), blob, type: "audio/wav" });
    } catch (_) { /* skip a clip we can't read */ }
  }
  const sent = clips.filter((_, i) => files.some((f) => f.name === clipName(clips[i], i)));
  const pdf = await buildReportPdf(night, sent);
  const day = new Date(night.startedAt).toISOString().slice(0, 10);
  const pdfName = `sonora-report-${day}.pdf`;
  files.unshift({ name: pdfName, blob: pdf, type: "application/pdf" });

  const n = files.length - 1;
  const clipsText = `${n} clip${n === 1 ? "" : "s"}`;
  const how = await shareFiles(files, "Sonora night report");
  if (how === "cancelled") return "Sharing cancelled.";
  if (how === "shared") return `Report shared with ${clipsText}.`;
  return n ? `Downloaded the report and ${clipsText}.` : "Downloaded the report.";
}
