// sleep.js — the full-screen night view shown while Sonora records:
// a starry sky, the time, a status dot that glows when a sound is heard,
// and a press-and-hold "Wake up" ring (holding avoids stopping by accident).

const HOLD_MS = 1500;
const $ = (id) => document.getElementById(id);

const clock = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const since = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

export function createSleepScreen({ onWake, onHide }) {
  const el = $("sleepScreen");
  const canvas = $("stars");
  const reduced = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let clockTimer = null, frame = null, stars = [], startedAt = null, heardTimer = null;

  // ---- stars
  function seedStars() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    const n = Math.round((canvas.clientWidth * canvas.clientHeight) / 5200);
    stars = Array.from({ length: n }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height * 0.85,
      r: (Math.random() < 0.08 ? 1.6 : 0.4 + Math.random() * 0.8) * dpr,
      phase: Math.random() * Math.PI * 2,
      speed: 0.25 + Math.random() * 0.9,
    }));
  }

  function drawStars(t) {
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const a = reduced ? 0.7 : 0.25 + 0.75 * Math.pow(Math.sin(s.phase + (t / 1000) * s.speed), 2);
      g.globalAlpha = a * (1 - s.y / canvas.height * 0.6);
      g.fillStyle = "#e9eeff";
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }

  let last = 0;
  function loop(t) {
    if (t - last > 50) { drawStars(t); last = t; }     // ~20 fps is plenty for a twinkle
    frame = requestAnimationFrame(loop);
  }

  // ---- clock and status
  function tick() {
    const now = new Date();
    // Big hours:minutes; AM/PM (in 12-hour locales) as a small label beside it.
    const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatToParts(now);
    const period = parts.find((p) => p.type === "dayPeriod");
    const el = $("sleepClock");
    el.textContent = parts.filter((p) => p.type !== "dayPeriod").map((p) => p.value).join("").trim();
    if (period) {
      const small = document.createElement("span");
      small.className = "sleep-ampm";
      small.textContent = period.value;
      el.appendChild(small);
    }
    $("sleepDate").textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (startedAt && !$("sleepStatus").dataset.waiting) {
      $("sleepSub").textContent = `Since ${clock(startedAt)} · ${since((now - startedAt) / 1000)}`;
    }
  }

  // ---- press and hold to wake up
  const hold = $("holdStop");
  let holdTimer = null;
  const beginHold = (e) => {
    if (e) e.preventDefault();
    if (holdTimer) return;
    hold.classList.add("holding");
    holdTimer = setTimeout(() => { holdTimer = null; hold.classList.remove("holding"); onWake(); }, HOLD_MS);
  };
  const cancelHold = () => {
    clearTimeout(holdTimer); holdTimer = null;
    hold.classList.remove("holding");
  };
  hold.addEventListener("pointerdown", beginHold);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) hold.addEventListener(ev, cancelHold);
  hold.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) beginHold(e); });
  hold.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") cancelHold(); });
  hold.addEventListener("contextmenu", (e) => e.preventDefault());

  $("sleepHide").addEventListener("click", () => { hide(); onHide(); });
  window.addEventListener("resize", () => { if (!el.hidden) { seedStars(); drawStars(performance.now()); } });

  function show(started) {
    startedAt = started || startedAt || new Date();
    el.hidden = false;
    document.body.style.overflow = "hidden";
    seedStars();
    tick();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000);
    cancelAnimationFrame(frame);
    if (reduced) drawStars(0); else frame = requestAnimationFrame(loop);
    hold.focus({ preventScroll: true });
  }

  function hide() {
    el.hidden = true;
    document.body.style.overflow = "";
    clearInterval(clockTimer);
    cancelAnimationFrame(frame);
    cancelHold();
  }

  // Live level from the recorder: { db, threshold, waitingS? }.
  function level(info) {
    if (el.hidden) return;
    const status = $("sleepStatus");
    if (info.waitingS > 0) {
      status.dataset.waiting = "1";
      status.textContent = "Getting ready";
      const m = Math.floor(info.waitingS / 60), s = Math.floor(info.waitingS % 60);
      $("sleepSub").textContent = `Starts listening in ${m}:${String(s).padStart(2, "0")}`;
      return;
    }
    if (status.dataset.waiting) { delete status.dataset.waiting; status.textContent = "Listening"; tick(); }
    if (info.db >= info.threshold) {
      const p = $("sleepPulse");
      p.classList.remove("heard"); void p.offsetWidth; p.classList.add("heard");
      clearTimeout(heardTimer);
      heardTimer = setTimeout(() => p.classList.remove("heard"), 1200);
    }
  }

  return { show, hide, level, get visible() { return !el.hidden; } };
}
