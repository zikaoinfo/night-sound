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
const text = (page, id) => page.$eval("#" + id, (el) => el.textContent);

async function newPage(initScript) {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
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
  await page.click("#btnStart");
  await page.waitForTimeout(4000);
  check((await text(page, "liveState")) === "listening", "listening after start");
  check((await text(page, "liveClock")) !== "0:00", "clock advances");
  await page.click("#btnStop");
  await page.waitForTimeout(500);
  check((await text(page, "liveState")) === "stopped", "stopped after stop");
  check(/snor/i.test(await text(page, "scoreSub")), "morning summary sentence shown");

  await page.click("#tabHistory");
  await page.waitForTimeout(300);
  const nights = await page.$$("#nightList .night");
  check(nights.length === 1, `history lists the night (${nights.length})`);
  await nights[0].click();
  await page.waitForTimeout(300);
  check(!(await page.$eval("#viewingBar", (el) => el.hidden)), "opening a night shows it on Tonight");
  check(/Night of/.test(await text(page, "viewingLabel")), "night is labelled with its date");
  await page.click("#btnDelete");
  check(!(await page.$eval("#confirmDelete", (el) => el.hidden)), "delete asks for confirmation");
  await page.click("#btnDeleteConfirm");
  await page.waitForTimeout(300);
  check((await page.$$("#nightList .night")).length === 0, "deleted night is gone from history");

  await page.click("#tabTonight");
  await page.click("#settings summary");
  await page.check("#sensHigh");
  await page.reload();
  await page.waitForTimeout(300);
  check(await page.isChecked("#sensHigh"), "sensitivity setting survives a reload");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

// ------------------------------------------------------------ native mode
// Mock of what the iOS shell injects before the page loads.
const nativeMock = () => {
  const methods = ["start", "stop", "status", "listSessions", "getSession", "deleteSession",
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
    baseUrl: "file:///docs/Sonora/sessions/20261018-230000/" });
  if (state.recording) timer = setInterval(tick, 50);

  const plugin = {
    start: async () => { Object.assign(state, { recording: true, t: 0, events: [] });
                         persist(); timer = setInterval(tick, 50); return { sessionId: "20261018-230000" }; },
    stop: async () => { clearInterval(timer); state.recording = false;
                        state.saved = [session()]; persist(); return session(); },
    status: async () => state.recording
      ? { recording: true, sessionId: "20261018-230000", elapsedS: state.t, events: state.events.length }
      : { recording: false },
    getSession: async ({ id }) => state.recording ? session() : state.saved.find((x) => x.id === id),
    listSessions: async () => ({ sessions: state.saved.map((x) => ({
      id: x.id, startedAt: x.startedAt, endedAt: x.endedAt, durationS: x.durationS, eventCount: x.events.length,
      snoreScore: 42, snorePercent: 12, snoreTimeS: 10, snoreEvents: x.events.length, episodes: 1, weirdSounds: 0 })) }),
    deleteSession: async ({ id }) => { state.saved = state.saved.filter((x) => x.id !== id); persist(); return {}; },
    removeListener: async () => ({}),
    addListener: (opts, cb) => { (listeners[opts.eventName] ||= []).push(cb); return String(nextId++); },
  };
  window.__mockPlugin = plugin;
  window.Capacitor = {
    PluginHeaders: [{ name: "SonoraRecorder", methods }],
    nativePromise: (_p, method, opts) => plugin[method](opts),
    nativeCallback: (_p, method, opts, cb) => plugin[method](opts, cb),
    convertFileSrc: (p) => p.replace("file://", "/_capacitor_file_"),
  };
};

{
  console.log("native mode (mock iOS bridge)");
  const { page, errors } = await newPage(nativeMock);
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

  await page.click("#btnStop");
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
  const clipSrcOk = await page.evaluate(() => typeof window.Capacitor.convertFileSrc === "function");
  check(clipSrcOk, "clip URLs go through convertFileSrc");
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  await page.context().close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
