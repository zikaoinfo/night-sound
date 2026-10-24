// history.js — past nights.
//   In the app: the native plugin's session folders (with clips).
//   In a browser: IndexedDB (events, per-second loudness, and the full-night
//   audio if it was recorded; short clips are only kept in memory).
// Every night comes back in one shape: { id, startedAt, meta, snap, clip, full, clipBlob }
// where clip(event) and full are player refs (see player.js) or null, and
// clipBlob(event) resolves the clip's audio for the report.

import { getNativeRecorder } from "./native.js";
import { computeReport } from "./analyzer.js";

const DB_NAME = "sonora";
const STORE = "nights";
const AUDIO = "audio";      // { id, blob } — full-night recordings

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of [STORE, AUDIO]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn, name = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const req = fn(tx.objectStore(name));
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const envelopeToPoints = (env) => env.map((db, i) => ({ t: i + 1, db }));

function summaryOf(report) {
  return {
    snoreScore: report.snoreScore,
    snorePercent: report.snorePercent,
    snoreTimeS: report.snoreTimeS,
    snoreEvents: report.snoreEvents,
    episodes: report.episodes.length,
    weirdSounds: report.weirdSounds.length,
  };
}

// Newest first: [{ id, startedAt, endedAt, durationS, snoreScore, snorePercent, ... }]
export async function listNights() {
  const native = await getNativeRecorder();
  if (native) {
    const { sessions } = await native.plugin.listSessions();
    return sessions;
  }
  try {
    const all = await withStore("readonly", (s) => s.getAll());
    return all
      .map((n) => ({ id: n.id, startedAt: n.startedAt, endedAt: n.endedAt,
                     durationS: n.durationS, meta: n.meta, ...n.summary }))
      .sort((a, b) => b.id.localeCompare(a.id));
  } catch (_) {
    return [];   // private mode or storage blocked: no history, app still works
  }
}

export async function loadNight(id) {
  const native = await getNativeRecorder();
  if (native) {
    const s = await native.plugin.getSession({ id });
    return {
      id, startedAt: s.startedAt, meta: normMeta(s.meta),
      snap: { events: s.events, envelope: envelopeToPoints(s.envelope),
              durationS: s.durationS, noiseFloorDbfs: s.noiseFloorDbfs },
      clip: (ev) => (ev.clip ? { id, file: ev.clip } : null),
      full: s.fullRecording ? { id, file: s.fullRecording } : null,
      clipBlob: (ev) => readNativeFile(native.plugin, id, ev.clip),
    };
  }
  const n = await withStore("readonly", (s) => s.get(id));
  if (!n) throw new Error("That night is no longer saved.");
  return {
    id, startedAt: n.startedAt, meta: normMeta(n.meta),
    snap: { events: n.events, envelope: envelopeToPoints(n.envelope),
            durationS: n.durationS, noiseFloorDbfs: n.noiseFloorDbfs },
    clip: () => null,
    full: await fullAudioRef(id),
    clipBlob: async () => null,
  };
}

export async function deleteNight(id) {
  const native = await getNativeRecorder();
  if (native) return native.plugin.deleteSession({ id });
  await withStore("readwrite", (s) => s.delete(id), AUDIO).catch(() => {});
  return withStore("readwrite", (s) => s.delete(id));
}

// A clip or recording stored by the native plugin, as a Blob.
export async function readNativeFile(plugin, id, file) {
  if (!file) return null;
  const { data } = await plugin.readSessionFile({ id, file });
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: file.endsWith(".wav") ? "audio/wav" : "audio/mp4" });
}

async function fullAudioRef(id) {
  try {
    const rec = await withStore("readonly", (s) => s.get(id), AUDIO);
    return rec ? { url: URL.createObjectURL(rec.blob) } : null;
  } catch (_) {
    return null;
  }
}

export const normMeta = (m) => ({ tags: [], rating: null, note: "", ...(m || {}) });

// Save a night's tags, rating and note.
export async function updateNightMeta(id, meta) {
  const m = normMeta(meta);
  const native = await getNativeRecorder();
  if (native) {
    const args = { id, tags: m.tags, note: m.note || "" };
    if (m.rating) args.rating = m.rating;
    return native.plugin.updateSession(args);
  }
  const n = await withStore("readonly", (s) => s.get(id));
  if (!n) return;
  n.meta = m;
  return withStore("readwrite", (s) => s.put(n));
}

// Browser only: the native plugin saves its own sessions.
export async function saveWebNight(snap, startedAt, meta, fullBlob) {
  const perSecond = [];
  for (const p of snap.envelope) {
    const i = Math.floor(p.t);
    perSecond[i] = Math.max(perSecond[i] ?? -120, p.db);
  }
  const envelope = Array.from(perSecond, (v) => v ?? -120);
  const pad = (n) => String(n).padStart(2, "0");
  const d = startedAt;
  const id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
             `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const night = {
    id,
    startedAt: d.toISOString(),
    endedAt: new Date().toISOString(),
    durationS: snap.durationS,
    noiseFloorDbfs: snap.noiseFloorDbfs,
    envelope,
    events: snap.events.map(({ clip, inEpisode, confirmedSnore, ...e }) => e),
    summary: summaryOf(computeReport(snap)),
    meta: normMeta(meta),
  };
  try {
    await withStore("readwrite", (s) => s.put(night));
    if (fullBlob) await withStore("readwrite", (s) => s.put({ id, blob: fullBlob }), AUDIO);
  } catch (_) {
    // Storage unavailable: the night still shows until the page is closed.
  }
  return id;
}

// ---------------------------------------------------------------- backup & restore
// A backup is one JSON file with every night's data (events, loudness curve,
// summary, notes). Audio isn't included: clips and full recordings stay on
// the device they were recorded on. The format is the same everywhere, so a
// backup from the browser restores on a phone and vice versa.

const EVENT_DEFAULTS = { peakDbfs: -120, centroid: 0, lowRatio: 0, flatness: 1, f0: 0, harmonicity: 0,
                         snoreProb: 0, isSnore: false, intensity: "quiet" };

function canonicalNight(n) {
  const events = (n.events || []).map((e) => {
    const { clip, inEpisode, confirmedSnore, ...rest } = e;
    const out = { ...EVENT_DEFAULTS, ...rest };
    out.durationS = out.durationS ?? out.endS - out.startS;
    return out;
  });
  const envelope = (n.envelope || []).map((v) => (typeof v === "number" ? v : v.db));
  const durationS = n.durationS || 0;
  const r = computeReport({ events: events.map((e) => ({ ...e })), durationS, noiseFloorDbfs: n.noiseFloorDbfs ?? -50 });
  return {
    id: n.id, startedAt: n.startedAt, endedAt: n.endedAt ?? null, durationS,
    noiseFloorDbfs: n.noiseFloorDbfs ?? -50, sensitivity: n.sensitivity || "normal",
    fullRecording: null, startDelayS: n.startDelayS || 0, envelope, events,
    summary: { ...summaryOf(r), snoresPerHour: r.snoresPerHour },
    meta: normMeta(n.meta),
  };
}

export async function exportBackup() {
  const native = await getNativeRecorder();
  let nights;
  if (native) {
    const { sessions } = await native.plugin.listSessions();
    nights = [];
    for (const s of sessions) nights.push(await native.plugin.getSession({ id: s.id }));
  } else {
    nights = await withStore("readonly", (s) => s.getAll());
  }
  return {
    app: "sonora", format: 1, exportedAt: new Date().toISOString(),
    nights: nights.filter((n) => n.endedAt).map(canonicalNight),
  };
}

// Returns { added, skipped } — nights already on this device are skipped.
export async function importBackup(backup) {
  if (!backup || backup.app !== "sonora" || !Array.isArray(backup.nights)) {
    throw new Error("That file isn't a Sonora backup.");
  }
  const native = await getNativeRecorder();
  let added = 0, skipped = 0;
  for (const raw of backup.nights) {
    if (!/^\d{8}-\d{6}$/.test(raw.id || "")) { skipped++; continue; }
    const n = canonicalNight(raw);
    if (native) {
      const { result } = await native.plugin.importSession({ json: JSON.stringify(n) });
      result === "added" ? added++ : skipped++;
    } else {
      const exists = await withStore("readonly", (s) => s.get(n.id));
      if (exists) { skipped++; continue; }
      await withStore("readwrite", (s) => s.put(n));
      added++;
    }
  }
  return { added, skipped };
}
