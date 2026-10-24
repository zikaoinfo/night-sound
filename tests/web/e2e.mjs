// End-to-end tests for the web app in headless Chromium.
//
//   node tests/web/e2e.mjs
//
// 1. Web mode: Chromium's fake microphone drives the Web Audio engine.
// 2. Native mode: a mock of the iOS bridge (PluginHeaders + nativePromise)
//    stands in for the SonoraRecorder plugin, so the real NativeSource code
//    path runs: start, live events, backgrounding + resume, stop, and
//    reattaching after the app is relaunched mid-night.
//
// Needs Playwright. Set PLAYWRIGHT_MODULE to its path if it isn't resolvable,
// and CHROMIUM to a browser binary if Playwright's own isn't installed.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const WEB = join(dirname(fileURLToPath(import.meta.url)), "../../web");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".png": "image/png", ".webmanifest": "application/manifest+json" };

const server = createServer(async (req, res) => {
  const path = join(WEB, decodeURIComponent(req.url.split("?")[0]).replace(/\/$/, "/index.html"));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
}).listen(0);
const URL = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
         "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  if (!cond) failures++;
};
// The sleep screen covers the app while recording; "Show details" first.
async function stopNight(page) {
  if (!(await page.$eval("#sleepScreen", (el) => el.hidden))) await page.click("#sleepHide");
  await page.click("#btnStop");
}
const text = (page, id) => page.$eval("#" + id, (el) => el.textContent);

async function newPage(initScript) {
  const ctx = await browser.newContext({ permissions: ["microphone"], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text());
  });
  if (initScript) await page.addInitScript(initScript);
  return { page, errors };
}

// ------------------------------------------------------------ web mode
{
  console.log("web mode (fake microphone)");
  const { page, errors } = await newPage();
  await page.goto(URL);
  await page.click('#factorChips .chip:has-text("Alcohol")');
  await page.click('#remedyChips .chip:has-text("Nasal strip")');
  await page.fill("#customTag", "Wine");
  await page.click("#customTagForm button");
  check(await page.$eval('#factorChips .chip:has-text("Wine")', (b) => b.getAttribute("aria-pressed")) === "true",
        "custom factor added and selected");
  await page.click("#btnStart");
  await page.waitForTimeout(4000);
  check((await text(page, "liveState")) === "listening", "listening after start");
  check((await text(page, "liveClock")) !== "0:00", "clock advances");
  await stopNight(page);
  await page.waitForTimeout(500);
  check((await text(page, "liveState")) === "stopped", "stopped after stop");
  check(/snor/i.test(await text(page, "scoreSub")), "morning summary sentence shown");
  check(!(await page.$eval("#morningBlock", (el) => el.hidden)), "rating and note offered after the night");
  await page.click('label:has(#rate4)');
  await page.fill("#nightNote", "Woke up twice");
  await page.waitForTimeout(700);

  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  const nights = await page.$$("#nightList .night");
  check(nights.length === 1, `history lists the night (${nights.length})`);
  const line = await page.$eval("#nightList .night-tags", (el) => el.textContent).catch(() => "");
  check(/rested 4\/5/.test(line) && /Alcohol/.test(line) && /Nasal strip/.test(line) && /Wine/.test(line),
        `night shows rating and tags ("${line}")`);
  await nights[0].click();
  await page.waitForTimeout(300);
  check(!(await page.$eval("#viewingBar", (el) => el.hidden)), "opening a night shows it on Tonight");
  check(/Night of/.test(await text(page, "viewingLabel")), "night is labelled with its date");
  check((await page.inputValue("#nightNote")) === "Woke up twice", "note is kept with the night");
  check(await page.$eval('#remedyChips .chip:has-text("Nasal strip")', (b) => b.getAttribute("aria-pressed")) === "true",
        "the night's remedies are shown");
  check(await page.$eval('#remedyChips .chip:has-text("Nasal strip")', (b) => b.getAttribute("aria-pressed")) === "true"
        && await page.$eval('#factorChips .chip:has-text("Alcohol")', (b) => b.getAttribute("aria-pressed")) === "true",
        "the night's factors are shown");
  await page.click("#btnDelete");
  check(!(await page.$eval("#confirmDelete", (el) => el.hidden)), "delete asks for confirmation");
  await page.click("#btnDeleteConfirm");
  await page.waitForTimeout(300);
  check((await page.$$("#nightList .night")).length === 0, "deleted night is gone from history");

  // Seed 4 nights: nasal strip on the two quieter ones.
  await page.evaluate(async () => {
    const { saveWebNight } = await import("./history.js");
    const night = async (day, pct, tags) => {
      const dur = 3600, events = [];
      for (let t = 10; t < dur * pct / 100 * 2; t += 2.5)
        events.push({ startS: t, endS: t + 1.2, durationS: 1.2, peakDbfs: -20, centroid: 400, lowRatio: .9,
          flatness: .2, f0: 110, harmonicity: .6, snoreProb: .8, isSnore: true, intensity: "loud" });
      await saveWebNight({ events, envelope: [], durationS: dur, noiseFloorDbfs: -55 }, new Date(2026, 9, day, 23), { tags });
    };
    await night(1, 30, ["alcohol"]); await night(2, 28, ["alcohol"]);
    await night(3, 5, ["nasalStrip"]); await night(4, 6, ["nasalStrip"]);
  });
  await page.click("#tabTonight");
  await page.click("#tabHistory");
  await page.waitForTimeout(400);
  const impact = await page.$$eval("#impactList .impact-item", (els) => els.map((e) => e.textContent));
  check(impact.some((t) => /Nasal strip/.test(t) && /−/.test(t)), "impact list: nasal strip goes with less snoring");
  check(impact.some((t) => /Alcohol/.test(t) && /\+/.test(t)), "impact list: alcohol goes with more snoring");

  await page.click("#tabTonight");
  await page.click("#settings summary");
  await page.check("#sensHigh");
  await page.reload();
  await page.waitForTimeout(300);
  check(await page.isChecked("#sensHigh"), "sensitivity setting survives a reload");
  // Doctor report: in a browser without file sharing, the PDF + clips download.
  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  await page.click("#nightList .night");
  await page.waitForTimeout(300);
  check(!(await page.$eval("#btnReport", (b) => b.hidden)), "share report offered for a saved night");
  const dl = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#btnReport");
  const file = await dl;
  const path = await file.path();
  const head = (await import("node:fs")).readFileSync(path).subarray(0, 5).toString();
  check(file.suggestedFilename().startsWith("sonora-report-") && head === "%PDF-",
        `report is a PDF (${file.suggestedFilename()})`);
  await page.waitForTimeout(500);
  check(/Downloaded the report/.test(await text(page, "note")), "tells you what it did");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ backup & restore
{
  console.log("backup & restore (web)");
  const { page, errors } = await newPage();
  await page.goto(URL);
  await page.evaluate(async () => {
    const { saveWebNight } = await import("./history.js");
    for (const day of [5, 6]) {
      const events = [{ startS: 10, endS: 11.2, durationS: 1.2, peakDbfs: -20, centroid: 400, lowRatio: .9,
        flatness: .2, f0: 110, harmonicity: .6, snoreProb: .8, isSnore: true, intensity: "loud" }];
      await saveWebNight({ events, envelope: [{ t: 1, db: -50 }], durationS: 600, noiseFloorDbfs: -55 },
                        new Date(2026, 9, day, 23), { tags: ["alcohol"], rating: 3, note: "n" });
    }
  });
  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  const dl = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#btnBackup");
  const file = await dl;
  const fs = await import("node:fs");
  const backupPath = await file.path();
  const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const n0 = backup.nights[0] || {};
  const keys = ["id", "startedAt", "endedAt", "durationS", "noiseFloorDbfs", "sensitivity", "envelope", "events", "summary", "meta"];
  check(backup.app === "sonora" && backup.nights.length === 2, `backup has both nights (${backup.nights.length})`);
  check(keys.every((k) => k in n0) && "snoresPerHour" in n0.summary && typeof n0.envelope[0] === "number",
        "nights use the shared format the phone apps read");
  await page.waitForTimeout(300);
  check(/Downloaded a backup of 2 nights/.test(await text(page, "backupStatus")), "says what was backed up");

  // Lose one night, then restore.
  await page.evaluate(async () => { const { deleteNight } = await import("./history.js"); await deleteNight("20261005-230000"); });
  await page.reload();
  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  check((await page.$$("#nightList .night")).length === 1, "one night left before restoring");
  await page.setInputFiles("#restoreFile", backupPath);
  await page.waitForTimeout(800);
  check(/Restored 1 night; 1 already here/.test(await text(page, "backupStatus")), "restore adds the missing night only");
  check((await page.$$("#nightList .night")).length === 2, "both nights listed after restore");
  const line = await page.$$eval("#nightList .night-tags", (els) => els.map((e) => e.textContent).join("|"));
  check(/rested 3\/5/.test(line) && /Alcohol/.test(line), "restored night keeps its notes");
  await page.setInputFiles("#restoreFile", { name: "x.json", mimeType: "application/json", buffer: Buffer.from("{nope") });
  await page.waitForTimeout(300);
  check(/isn't a Sonora backup/.test(await text(page, "backupStatus")), "rejects a file that isn't a backup");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ sleep screen
{
  console.log("sleep screen (web)");
  const { page, errors } = await newPage();
  await page.goto(URL);
  await page.click("#btnStart");
  await page.waitForTimeout(1200);
  check(!(await page.$eval("#sleepScreen", (el) => el.hidden)), "sleep screen opens when the night starts");
  check(/^\d{1,2}:\d{2}/.test(await text(page, "sleepClock")), `shows the time (${await text(page, "sleepClock")})`);
  check(/^Since /.test(await text(page, "sleepSub")), "shows when it started");
  const box = await page.$eval("#holdStop", (b) => { const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.up();
  await page.waitForTimeout(300);
  check((await text(page, "liveState")) === "listening", "a short tap doesn't stop the night");
  await page.click("#sleepHide");
  check(await page.$eval("#sleepScreen", (el) => el.hidden), "Show details goes back to the app");
  await page.click("#btnNight");
  check(!(await page.$eval("#sleepScreen", (el) => el.hidden)), "Night view reopens it");
  await page.mouse.move(box.x, box.y);
  await page.mouse.down(); await page.waitForTimeout(1800); await page.mouse.up();
  await page.waitForTimeout(800);
  check((await text(page, "liveState")) === "stopped", "press and hold wakes up (stops the night)");
  check(await page.$eval("#sleepScreen", (el) => el.hidden), "sleep screen closes in the morning");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ start delay
{
  console.log("start delay (web)");
  const { page, errors } = await newPage(() =>
    localStorage.setItem("sonora:settings", JSON.stringify({ startDelayS: 2 })));
  await page.goto(URL);
  await page.click("#btnStart");
  await page.waitForTimeout(600);
  check((await text(page, "liveState")) === "waiting", "waits during the start delay");
  check(/starts listening in/i.test(await text(page, "scoreSub")), "shows a countdown");
  await page.waitForTimeout(2600);
  check((await text(page, "liveState")) === "listening", "starts listening after the delay");
  await stopNight(page);
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ full-night recording
{
  console.log("full-night recording (web)");
  const { page, errors } = await newPage(() =>
    localStorage.setItem("sonora:settings", JSON.stringify({ fullRecording: true })));
  await page.goto(URL);
  check(await page.isChecked("#optFull"), "full-night setting shown and on");
  await page.click("#btnStart");
  await page.waitForTimeout(3500);
  check(await page.$eval("#fullPlayer", (el) => el.hidden), "no player while recording");
  await stopNight(page);
  await page.waitForTimeout(800);
  check(!(await page.$eval("#fullPlayer", (el) => el.hidden)), "player appears after the night");
  await page.reload();
  await page.click("#tabHistory");
  await page.waitForTimeout(400);
  await page.click("#nightList .night");
  await page.waitForTimeout(600);
  check(!(await page.$eval("#fullPlayer", (el) => el.hidden)), "saved night keeps its full recording");
  await page.click("#playToggle");
  await page.waitForTimeout(800);
  check(await text(page, "playToggle") === "❚❚", "play button starts the recording");
  check(/^0:0[0-9] \/ 0:0[1-9]$/.test(await text(page, "playTime")), `shows position / length (${await text(page, "playTime")})`);
  await page.click("#playToggle");
  await page.waitForTimeout(300);
  check(await text(page, "playToggle") === "▶", "play button pauses");
  const box = await page.$eval("#timeline", (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(box.x + box.w * 0.5, box.y + box.h / 2);
  await page.waitForTimeout(500);
  const t = await page.$eval("#fullAudio", (a) => a.currentTime);
  check(t > 0, `tapping the timeline seeks the recording (t=${t.toFixed(2)})`);
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ native mode
// Mock of what the iOS shell injects before the page loads.
const nativeMock = () => {
  const methods = ["start", "stop", "status", "listSessions", "getSession", "deleteSession", "updateSession", "writeShareFile", "playFile", "pausePlayback", "resumePlayback", "seekPlayback", "stopPlayback", "readSessionFile", "takeCommand",
                   "removeListener"].map((name) => ({ name, rtype: "promise" }));
  methods.push({ name: "addListener", rtype: "callback" });
  window.webkit = { messageHandlers: { bridge: { postMessage() {} } } };

  const state = JSON.parse(sessionStorage.getItem("mock") || "null") ||
    { recording: false, t: 0, events: [], saved: [] };
  const persist = () => sessionStorage.setItem("mock", JSON.stringify(state));
  const listeners = {};
  let nextId = 1, timer = null;

  const emit = (name, data) => (listeners[name] || []).forEach((cb) => cb(data));
  const tick = () => {
    state.t += 0.25;
    emit("level", { t: state.t, db: -40, floor: -55, threshold: -46 });
    if (Math.abs(state.t % 3) < 0.01) {
      const ev = { startS: state.t - 1.2, endS: state.t, durationS: 1.2, peakDbfs: -20,
        centroid: 400, lowRatio: 0.9, flatness: 0.2, f0: 110, harmonicity: 0.6,
        snoreProb: 0.8, isSnore: true, intensity: "loud", clip: `clips/clip-${state.events.length}.wav` };
      state.events.push(ev);
      emit("soundEvent", ev);
    }
    persist();
  };
  const session = () => ({ id: "20261018-230000", startedAt: "2026-10-18T23:00:00Z",
    endedAt: state.recording ? null : "2026-10-19T06:30:00Z", durationS: state.t, noiseFloorDbfs: -55,
    envelope: Array.from({ length: Math.floor(state.t) }, () => -45), events: state.events,
    baseUrl: "file:///docs/Sonora/sessions/20261018-230000/", meta: state.meta, fullRecording: "full.m4a" });
  if (state.recording) timer = setInterval(tick, 50);

  const plugin = {
    start: async (o) => { Object.assign(state, { recording: true, t: 0, events: [], meta: { tags: o.tags || [] } });
                         persist(); timer = setInterval(tick, 50); return { sessionId: "20261018-230000" }; },
    stop: async () => { clearInterval(timer); state.recording = false;
                        state.saved = [session()]; persist(); return session(); },
    status: async () => state.recording
      ? { recording: true, sessionId: "20261018-230000", elapsedS: state.t, events: state.events.length }
      : { recording: false },
    getSession: async ({ id }) => state.recording ? session() : state.saved.find((x) => x.id === id),
    listSessions: async () => ({ sessions: state.saved.map((x) => ({
      id: x.id, startedAt: x.startedAt, endedAt: x.endedAt, durationS: x.durationS, eventCount: x.events.length,
      snoreScore: 42, snorePercent: 12, snoreTimeS: 10, snoreEvents: x.events.length, episodes: 1, weirdSounds: 0,
      meta: x.meta })) }),
    updateSession: async ({ id, ...meta }) => { state.meta = meta;
      state.saved.forEach((x) => { if (x.id === id) x.meta = meta; }); persist(); return {}; },
    deleteSession: async ({ id }) => { state.saved = state.saved.filter((x) => x.id !== id); persist(); return {}; },
    playFile: async ({ id, file, at }) => {
      window.__played = (window.__played || []).concat({ id, file, at });
      clearInterval(window.__pb);
      let t = at || 0;
      emit("playback", { state: "playing", t, duration: 30, id, file });
      window.__pb = setInterval(() => { t += 0.25; emit("playback", { state: "playing", t, duration: 30, id, file }); }, 250);
    },
    pausePlayback: async () => { clearInterval(window.__pb); emit("playback", { state: "paused", t: 1, duration: 30 }); },
    resumePlayback: async () => { emit("playback", { state: "playing", t: 1, duration: 30 }); },
    seekPlayback: async () => ({}),
    stopPlayback: async () => { clearInterval(window.__pb); },
    takeCommand: async () => { const c = sessionStorage.getItem("cmd"); sessionStorage.removeItem("cmd"); return { command: c }; },
    readSessionFile: async ({ file }) => ({ data: btoa("RIFF" + "x".repeat(2000)) }),
    writeShareFile: async ({ name, data }) => {
      window.__written = (window.__written || []).concat({ name, bytes: atob(data).length });
      return { uri: "file:///cache/share/" + name };
    },
    removeListener: async () => ({}),
    addListener: (opts, cb) => { (listeners[opts.eventName] ||= []).push(cb); return String(nextId++); },
  };
  window.__mockPlugin = plugin;
  window.__emit = emit;
  window.Capacitor = {
    PluginHeaders: [{ name: "SonoraRecorder", methods }, { name: "Share", methods: [{ name: "share", rtype: "promise" }] }],
    nativePromise: (p, method, opts) => p === "Share"
      ? (window.__shared = opts, Promise.resolve({}))
      : plugin[method](opts),
    nativeCallback: (_p, method, opts, cb) => plugin[method](opts, cb),
    convertFileSrc: (p) => p.replace("file://", "/_capacitor_file_"),
  };
};

{
  console.log("native mode (mock iOS bridge)");
  const { page, errors } = await newPage(nativeMock);
  // Files the real app would read from the device; the mock has none.
  await page.route("**/_capacitor_file_/**", (r) => r.fulfill({ status: 200, contentType: "audio/mp4", body: "" }));
  await page.goto(URL);
  await page.click("#btnStart");
  await page.waitForTimeout(1200);           // ~24 mock ticks = 6 s of "night"
  check((await text(page, "liveState")) === "listening", "listening after start");
  check(/lock the screen/.test(await text(page, "scoreSub")), "tells you the screen can be locked");
  const items = await page.$$eval("#eventList .ev-badge.snore", (els) => els.length);
  check(items >= 1, `live snore events rendered (${items})`);

  // Simulate the app going to the background and coming back.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(300);
  const afterResume = await page.$$eval("#eventList .ev-badge.snore", (els) => els.length);
  check(afterResume === items || afterResume === items + 1, "resume doesn't duplicate events");

  // Relaunch mid-night: the page reloads while the plugin is still recording.
  await page.reload();
  await page.waitForTimeout(800);
  check((await text(page, "liveState")) === "listening", "reattaches to a running session after relaunch");

  await stopNight(page);
  await page.waitForTimeout(300);
  check((await text(page, "liveState")) === "stopped", "stopped after stop");
  check(Number(await text(page, "statEvents")) >= 2, "summary counts snore events");
  const play = await page.$("#eventList .ev-play");
  check(!!play, "stored clips are playable");

  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  check((await page.$$("#nightList .night")).length === 1, "native history lists the saved night");
  await page.click("#nightList .night");
  await page.waitForTimeout(300);
  check(!!(await page.$("#eventList .ev-play")), "a saved night's clips are playable");
  // Clips and the full night play natively through the plugin.
  await page.click("#eventList .ev-play");
  await page.waitForTimeout(300);
  let last = await page.evaluate(() => window.__played.at(-1));
  check(last && /^clips\/clip-\d+\.wav$/.test(last.file) && last.id === "20261018-230000",
        `native: clip played by the plugin (${JSON.stringify(last)})`);
  check(!(await page.$eval("#fullPlayer", (el) => el.hidden)), "native: full recording offered");
  await page.click("#playToggle");
  await page.waitForTimeout(600);
  last = await page.evaluate(() => window.__played.at(-1));
  check(last && last.file === "full.m4a", "native: play button plays the full night");
  check(await text(page, "playToggle") === "❚❚" && /^0:0[1-9] \//.test(await text(page, "playTime")),
        `native: progress shown (${await text(page, "playTime")})`);
  const tl = await page.$eval("#timeline", (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.mouse.click(tl.x + tl.w * 0.75, tl.y + tl.h / 2);
  await page.waitForTimeout(300);
  last = await page.evaluate(() => window.__played.at(-1));
  check(last && last.file === "full.m4a" && last.at > 0, `native: timeline tap seeks (at=${last && last.at && last.at.toFixed(1)})`);
  await page.click("#playToggle");
  await page.waitForTimeout(300);
  check(await text(page, "playToggle") === "▶", "native: pause");
  await page.click('#factorChips .chip:has-text("Late meal")');
  await page.click('label:has(#rate2)');
  await page.waitForTimeout(700);
  const meta = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock")).meta);
  check(meta && meta.rating === 2 && meta.tags.includes("lateMeal"), "native: tags and rating saved via updateSession");

  // Share report in the app: files go to the cache via the plugin, then to the share sheet.
  await page.click("#btnReport");
  await page.waitForTimeout(2500);
  const shared = await page.evaluate(() => ({ s: window.__shared, w: window.__written }));
  check(shared.s && shared.s.files && shared.s.files[0].endsWith(".pdf") && shared.s.files[0].startsWith("file:///cache/share/"),
        "native: report handed to the share sheet");
  check(shared.w && shared.w[0].bytes > 1000, "native: PDF written through the plugin");
  check(shared.s.files.some((f) => f.endsWith(".wav")), "native: clips read through the plugin and attached");
  check(/Report shared/.test(await text(page, "note")), "native: says the report was shared");

  // iOS labels other sounds; the list and the summary use the label.
  await page.evaluate(() => {
    const st = JSON.parse(sessionStorage.getItem("mock"));
    st.saved[0].events.push({ startS: 2.0, endS: 2.6, durationS: 0.6, peakDbfs: -8, centroid: 1800, lowRatio: .3,
      flatness: .5, f0: 0, harmonicity: .1, snoreProb: .2, isSnore: false, intensity: "epic", sound: "speech",
      clip: "clips/clip-99999.wav" });
    sessionStorage.setItem("mock", JSON.stringify(st));
  });
  await page.reload();
  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  await page.click("#nightList .night");
  await page.waitForTimeout(300);
  const badges = await page.$$eval("#eventList .ev-badge", (els) => els.map((e) => e.textContent));
  check(badges.includes("speech"), "labelled sound shows its name");
  check(/\(speech\)/.test(await text(page, "scoreSub")), "summary names the other sound");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ Siri / Shortcuts
{
  console.log("Siri: start sleep / wake up (mock iOS bridge)");
  const { page, errors } = await newPage(nativeMock);
  await page.addInitScript(() => { if (!sessionStorage.getItem("seen")) { sessionStorage.setItem("seen", "1"); sessionStorage.setItem("cmd", "startSleep"); } });
  await page.goto(URL);
  await page.waitForTimeout(1000);
  check((await text(page, "liveState")) === "listening", "\"Start sleep\" from a cold start begins the night");
  check(!(await page.$eval("#sleepScreen", (el) => el.hidden)), "and shows the sleep screen");
  await page.evaluate(() => window.__emit("command", { command: "wakeUp" }));
  await page.waitForTimeout(800);
  check((await text(page, "liveState")) === "stopped", "\"Wake up\" while open ends the night");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
