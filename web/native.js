// native.js — bridge to the SonoraRecorder plugin when running inside the
// iOS/Android app. In a plain browser `getNativeRecorder()` resolves null and
// the app falls back to Web Audio.
//
// vendor/capacitor-core.js is @capacitor/core 8.5.3's ESM build, copied in
// because the web app has no bundler.

let corePromise = null;

function loadCore() {
  if (!corePromise) corePromise = import("./vendor/capacitor-core.js").catch(() => null);
  return corePromise;
}

let nativePromise = null;

// Resolves to { plugin } inside the app, or null in a browser. The plugin is
// wrapped because Capacitor plugin proxies answer every property — including
// `then` — so returning one bare from a promise makes `await` call a native
// method named "then". Registered once and cached.
export function getNativeRecorder() {
  if (!nativePromise) {
    nativePromise = loadCore().then((core) =>
      core && core.Capacitor.isNativePlatform()
        ? { plugin: core.registerPlugin("SonoraRecorder") }
        : null);
  }
  return nativePromise;
}

// File URL of a stored clip -> URL the WebView can load.
export function clipUrl(baseUrl, clip) {
  const file = baseUrl.replace(/\/?$/, "/") + clip;
  const cap = window.Capacitor;
  return cap && cap.convertFileSrc ? cap.convertFileSrc(file) : file;
}
