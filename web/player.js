// player.js — one player for clips and full-night recordings.
//   In the app: the SonoraRecorder plugin plays files natively (the WebView's
//   <audio> can't reliably stream app files, and native playback ignores the
//   silent switch).
//   In a browser: an <audio> element.
// A "ref" names what to play: { url } in a browser, { id, file } in the app.

export function refKey(ref) {
  return ref ? (ref.url || `${ref.id}/${ref.file}`) : "";
}

export function createPlayer({ plugin, audio, onChange }) {
  const state = { key: "", playing: false, t: 0, duration: 0 };
  const changed = () => onChange({ ...state });

  if (plugin) {
    plugin.addListener("playback", (s) => {
      state.playing = s.state === "playing";
      state.t = s.t;
      if (s.duration) state.duration = s.duration;
      if (s.state === "ended") state.t = state.duration;
      changed();
    });
    return {
      state: () => ({ ...state }),
      async play(ref, at = 0) {
        state.key = refKey(ref);
        state.t = at;
        await plugin.playFile({ id: ref.id, file: ref.file, at });
      },
      async toggle() {
        if (!state.key) return;
        if (state.playing) await plugin.pausePlayback();
        else if (state.duration && state.t >= state.duration - 0.1) await plugin.seekPlayback({ t: 0 }).then(() => plugin.resumePlayback());
        else await plugin.resumePlayback();
      },
      async seek(t) { await plugin.seekPlayback({ t }); },
      async stop() { await plugin.stopPlayback(); state.key = ""; state.playing = false; changed(); },
    };
  }

  const update = () => {
    state.playing = !audio.paused && !audio.ended;
    state.t = audio.currentTime || 0;
    state.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    changed();
  };
  for (const ev of ["play", "pause", "ended", "timeupdate", "loadedmetadata", "seeked"]) {
    audio.addEventListener(ev, update);
  }
  const ready = () => (audio.readyState >= 1 ? Promise.resolve()
    : new Promise((res) => audio.addEventListener("loadedmetadata", res, { once: true })));

  return {
    state: () => ({ ...state }),
    async play(ref, at = 0) {
      const key = refKey(ref);
      if (state.key !== key) { audio.src = ref.url; state.key = key; }
      await ready();
      audio.currentTime = Math.max(0, at);
      await audio.play();
    },
    async toggle() {
      if (!state.key) return;
      if (audio.paused) await audio.play(); else audio.pause();
    },
    async seek(t) { await ready(); audio.currentTime = Math.max(0, t); },
    async stop() { audio.pause(); audio.removeAttribute("src"); state.key = ""; update(); },
  };
}
