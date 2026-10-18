"""Measure detection accuracy on clips you have labelled by ear.

Lay clips out one folder per label; a folder named ``snore`` holds the
positives and every other folder (``other``, ``cough``, ``talking``, ...) holds
negatives:

    labelled/
      snore/   clip-001.wav ...
      other/   clip-007.wav ...

The easiest way to get clips is from a real night:

    python -m nightsound analyse night.m4a -o out/ --clips all

then listen to ``out/clips/`` and move each file into the right folder.

Each clip is scored as one isolated sound, so the numbers describe
``_snore_probability`` on its own; rhythmic runs (episodes) only make the real
detector more forgiving than this.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from . import analysis, audio

AUDIO_EXT = {".wav", ".m4a", ".mp3", ".aac", ".flac", ".ogg", ".opus", ".caf"}


@dataclass
class Scored:
    path: str
    label: str
    prob: float


def score_folder(root: str) -> list[Scored]:
    out: list[Scored] = []
    for label in sorted(os.listdir(root)):
        folder = os.path.join(root, label)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            if os.path.splitext(name)[1].lower() not in AUDIO_EXT:
                continue
            path = os.path.join(folder, name)
            x = audio.read_region(path, 0.0, 30.0)
            ev = analysis.Event(start_s=0.0, end_s=len(x) / audio.TARGET_SR)
            analysis._extract_features(x, audio.TARGET_SR, ev)
            out.append(Scored(path, label.lower(), analysis._snore_probability(ev)))
    return out


def metrics(scored: list[Scored], threshold: float) -> dict:
    tp = sum(1 for s in scored if s.label == "snore" and s.prob >= threshold)
    fn = sum(1 for s in scored if s.label == "snore" and s.prob < threshold)
    fp = sum(1 for s in scored if s.label != "snore" and s.prob >= threshold)
    tn = sum(1 for s in scored if s.label != "snore" and s.prob < threshold)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"threshold": threshold, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": precision, "recall": recall, "f1": f1}


def report(root: str) -> str:
    scored = score_folder(root)
    if not scored:
        return f"No audio clips found in label folders under {root!r}."
    if not any(s.label == "snore" for s in scored):
        return "No 'snore' folder (or it is empty) — label at least a few snores."

    lines = ["=" * 60, " DETECTION CHECK ON YOUR LABELLED CLIPS", "=" * 60]
    for label in sorted({s.label for s in scored}):
        probs = [s.prob for s in scored if s.label == label]
        lines.append(f" {label:10s} {len(probs):4d} clips   snore probability "
                     f"mean {np.mean(probs):.2f}  min {min(probs):.2f}  max {max(probs):.2f}")

    lines.append("-" * 60)
    lines.append(" threshold  precision  recall   F1     (false +, missed)")
    sweep = [metrics(scored, t) for t in np.round(np.arange(0.30, 0.86, 0.05), 2)]
    for m in sweep:
        mark = "  <- current" if abs(m["threshold"] - 0.5) < 1e-9 else ""
        lines.append(f"   {m['threshold']:.2f}      {m['precision']:6.2f}    {m['recall']:5.2f}  "
                     f"{m['f1']:5.2f}     ({m['fp']}, {m['fn']}){mark}")

    best = max(sweep, key=lambda m: (m["f1"], m["threshold"]))
    lone = min((m for m in sweep if m["fp"] == 0), key=lambda m: m["threshold"], default=None)
    lines.append("-" * 60)
    lines.append(f" Suggested snore threshold (best F1): {best['threshold']:.2f}")
    if lone is not None:
        lines.append(f" Lowest threshold with no false positives: {lone['threshold']:.2f} "
                     f"(a good LONE_SNORE_MIN)")
    lines.append(" Set them via --threshold, or SNORE/LONE constants in nightsound/analysis.py,")
    lines.append(" web/analyzer.js (CFG) and the native SnoreEngine files.")

    wrong = [s for s in scored if (s.label == "snore") != (s.prob >= 0.5)]
    if wrong:
        lines.append("-" * 60)
        lines.append(f" Misclassified at 0.50 ({len(wrong)}):")
        for s in sorted(wrong, key=lambda s: s.prob)[:20]:
            lines.append(f"   {s.prob:.2f}  {s.label:8s} {os.path.relpath(s.path, root)}")
    return "\n".join(lines)
