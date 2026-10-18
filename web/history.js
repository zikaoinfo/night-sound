// history.js — past nights.
//   In the app: the native plugin's session folders (with clips).
//   In a browser: IndexedDB (events and per-second loudness; clips are only
//   kept in memory, so they don't survive a reload).
// Every night comes back in one shape: { id, startedAt, snap, clipSrc }.

import { getNativeRecorder, clipUrl } from "./native.js";
import { computeReport } from "./analyzer.js";

const DB_NAME = "sonora";
const STORE = "nights";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
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
      clipSrc: (ev) => (ev.clip ? clipUrl(s.baseUrl, ev.clip) : null),
    };
  }
  const n = await withStore("readonly", (s) => s.get(id));
  if (!n) throw new Error("That night is no longer saved.");
  return {
    id, startedAt: n.startedAt, meta: normMeta(n.meta),
    snap: { events: n.events, envelope: envelopeToPoints(n.envelope),
            durationS: n.durationS, noiseFloorDbfs: n.noiseFloorDbfs },
    clipSrc: () => null,
  };
}

export async function deleteNight(id) {
  const native = await getNativeRecorder();
  if (native) return native.plugin.deleteSession({ id });
  return withStore("readwrite", (s) => s.delete(id));
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
export async function saveWebNight(snap, startedAt, meta) {
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
  } catch (_) {
    // Storage unavailable: the night still shows until the page is closed.
  }
  return id;
}
