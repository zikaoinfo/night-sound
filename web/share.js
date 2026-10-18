// share.js — hand files to the system share sheet (Mail, Messages, AirDrop,
// Files, Drive, ...). In the app: write to the cache folder and use the Share
// plugin. In a browser: Web Share with files where supported, else download.

import { getNativeRecorder } from "./native.js";

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result).split(",")[1]);
  fr.onerror = () => reject(fr.error);
  fr.readAsDataURL(blob);
});

let plugins = null;
async function nativePlugins() {
  if (!plugins) {
    const core = await import("./vendor/capacitor-core.js");
    plugins = { Filesystem: core.registerPlugin("Filesystem"), Share: core.registerPlugin("Share") };
  }
  return plugins;
}

// files: [{ name, blob, type }]. Resolves "shared", "downloaded" or "cancelled".
export async function shareFiles(files, title) {
  if (await getNativeRecorder()) {
    const { Filesystem, Share } = await nativePlugins();
    const uris = [];
    for (const f of files) {
      const { uri } = await Filesystem.writeFile({ path: `share/${f.name}`, data: await blobToBase64(f.blob),
                                                   directory: "CACHE", recursive: true });
      uris.push(uri);
    }
    try {
      await Share.share({ title, files: uris, dialogTitle: title });
    } catch (err) {
      if (/cancel/i.test(err.message || "")) return "cancelled";
      throw err;
    }
    return "shared";
  }

  const shareable = files.map((f) => new File([f.blob], f.name, { type: f.type }));
  if (navigator.canShare && navigator.canShare({ files: shareable })) {
    try {
      await navigator.share({ title, files: shareable });
      return "shared";
    } catch (err) {
      if (err.name === "AbortError") return "cancelled";
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f.blob);
    const a = document.createElement("a");
    a.href = url; a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return "downloaded";
}
