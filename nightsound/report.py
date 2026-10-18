"""Render a SessionReport: text summary, JSON, timeline PNG, and audio clips."""

from __future__ import annotations

import json
import os
import subprocess

from .analysis import SessionReport


def _hms(seconds: float) -> str:
    seconds = int(round(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


def text_summary(rep: SessionReport) -> str:
    lines = []
    lines.append("=" * 52)
    lines.append(" NIGHT SOUND REPORT")
    lines.append("=" * 52)
    lines.append(f" File            : {os.path.basename(rep.file)}")
    lines.append(f" Recording length: {_hms(rep.duration_s)}")
    lines.append(f" Room noise floor: {rep.noise_floor_dbfs:.1f} dBFS")
    lines.append("-" * 52)
    lines.append(f" SNORE SCORE     : {rep.snore_score:.0f} / 100")
    lines.append(f" Time snoring    : {_hms(rep.snore_time_s)}  ({rep.snore_percent:.1f}% of night)")
    lines.append(f" Snore events    : {rep.snore_events}   ({rep.snores_per_hour:.1f}/hour)")
    lines.append(f" Snoring episodes: {len(rep.episodes)} rhythmic run(s)")
    ic = rep.intensity_counts
    lines.append(f" Intensity       : quiet {ic.get('quiet',0)} | light {ic.get('light',0)} "
                 f"| loud {ic.get('loud',0)} | epic {ic.get('epic',0)}")
    lines.append("-" * 52)
    if rep.episodes:
        lines.append(" Loudest / longest episodes:")
        top = sorted(rep.episodes, key=lambda e: e["snores"], reverse=True)[:5]
        for e in top:
            lines.append(f"   {_hms(e['start_s'])}–{_hms(e['end_s'])}  "
                         f"{e['snores']} snores, every {e['mean_interval_s']:.1f}s")
        lines.append("-" * 52)
    if rep.weird_sounds:
        lines.append(f" Other loud sounds ({len(rep.weird_sounds)}):")
        for w in rep.weird_sounds[:8]:
            lines.append(f"   {_hms(w['start_s'])}  {w['peak_dbfs']:.0f} dBFS  "
                         f"({w['intensity']}, ~{w['centroid_hz']:.0f} Hz)")
        if len(rep.weird_sounds) > 8:
            lines.append(f"   ... and {len(rep.weird_sounds) - 8} more")
        lines.append("-" * 52)
    return "\n".join(lines)


def write_json(rep: SessionReport, path: str) -> None:
    with open(path, "w") as f:
        json.dump(rep.to_dict(), f, indent=2)


def write_timeline(rep: SessionReport, path: str) -> None:
    """A SnoreLab-style timeline: snore events in colour, other sounds marked."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.patches import Patch

    colours = {"quiet": "#8ecae6", "light": "#219ebc", "loud": "#fb8500", "epic": "#d00000"}
    fig, ax = plt.subplots(figsize=(12, 3.2))
    hours = rep.duration_s / 3600.0

    for e in rep.events:
        if e.is_snore:
            ax.axvspan(e.start_s / 3600.0, e.end_s / 3600.0, 0.15, 0.95,
                       color=colours.get(e.intensity, "#219ebc"), lw=0)
    for w in rep.weird_sounds:
        ax.plot(w["start_s"] / 3600.0, 0.05, marker="^", color="#6a4c93", ms=7)

    ax.set_xlim(0, max(hours, 0.01))
    ax.set_ylim(0, 1)
    ax.set_yticks([])
    ax.set_xlabel("hours into the recording")
    ax.set_title(f"Night sound timeline — Snore Score {rep.snore_score:.0f}/100, "
                 f"{rep.snore_percent:.0f}% of night", fontsize=11)
    legend = [Patch(color=c, label=k) for k, c in colours.items()]
    legend.append(Patch(color="#6a4c93", label="other sound"))
    ax.legend(handles=legend, loc="upper right", ncol=5, fontsize=8, framealpha=0.9)
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    plt.close(fig)


def extract_clips(rep: SessionReport, src: str, out_dir: str,
                  what: str = "episodes", pad_s: float = 0.5) -> list[str]:
    """Cut short audio clips for review. `what`: 'episodes' | 'snores' | 'weird'."""
    os.makedirs(out_dir, exist_ok=True)
    jobs: list[tuple[str, float, float]] = []
    if what == "episodes":
        for i, e in enumerate(rep.episodes):
            jobs.append((f"episode_{i:02d}", e["start_s"], e["end_s"]))
    elif what == "snores":
        for i, e in enumerate(ev for ev in rep.events if ev.is_snore):
            jobs.append((f"snore_{i:03d}", e.start_s, e.end_s))
    elif what == "weird":
        for i, w in enumerate(rep.weird_sounds):
            jobs.append((f"weird_{i:02d}", w["start_s"], w["end_s"]))
    elif what == "all":
        # every detected sound, for labelling by ear (see nightsound/evaluate.py)
        for i, e in enumerate(rep.events):
            jobs.append((f"{i:04d}_{e.label}_{int(e.start_s)}s", e.start_s, e.end_s))
    else:
        raise ValueError(f"unknown clip set {what!r}")

    written = []
    for name, start, end in jobs:
        dst = os.path.join(out_dir, f"{name}.wav")
        start = max(0.0, start - pad_s)
        dur = (end - start) + 2 * pad_s
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", src,
             "-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-ac", "1", dst],
            check=True,
        )
        written.append(dst)
    return written
