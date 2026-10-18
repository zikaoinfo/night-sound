#!/usr/bin/env python3
"""Benchmark an on-device sound classifier (YAMNet) against our rule-based engine.

YAMNet is the lightweight, cross-platform AudioSet classifier (521 classes
incl. Snoring / Snort / Breathing / Cough / Speech). This harness runs it on a
folder of labelled clips and reports the top labels, whether a snore-family
class won, and latency — next to our own rule-based engine for reference.

It needs the YAMNet model downloaded locally (not committed — ~15 MB):

    mkdir -p bench/model && cd bench/model
    BASE=https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet
    for f in yamnet.py params.py features.py yamnet_class_map.csv; do curl -sO "$BASE/$f"; done
    curl -sO https://storage.googleapis.com/audioset/yamnet.h5
    pip install tensorflow-cpu tf_keras

Run on a folder of .wav clips (any ffmpeg-readable format works):

    TF_USE_LEGACY_KERAS=1 python bench/classify_bench.py --clips path/to/clips

Use REAL recordings. YAMNet is trained on real audio and will mislabel
synthetic tones as "Music" — a meaningful accuracy benchmark needs real
snore/cough/speech clips you have labelled by ear.
"""
from __future__ import annotations

import argparse, glob, os, sys, time
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..",))
from nightsound import audio, analysis  # noqa: E402

SNORE_FAMILY = {"Snoring", "Snort", "Breathing", "Wheeze", "Gasp"}


def load_clip(path: str) -> np.ndarray:
    return audio.read_region(path, 0.0, 60.0, sr=16000).astype(np.float32)


def run(clips_dir: str, model_dir: str) -> None:
    files = sorted(glob.glob(os.path.join(clips_dir, "*")))
    files = [f for f in files if not f.endswith(".py")]
    if not files:
        sys.exit(f"no clips in {clips_dir}")

    sys.path.insert(0, model_dir)
    import params as yp, yamnet as ym
    params = yp.Params()
    model = ym.yamnet_frames_model(params)
    model.load_weights(os.path.join(model_dir, "yamnet.h5"))
    names = ym.class_names(os.path.join(model_dir, "yamnet_class_map.csv"))

    _ = model(load_clip(files[0]))  # warm up

    mb = os.path.getsize(os.path.join(model_dir, "yamnet.h5")) / 1e6
    print(f"\nYAMNet (weights {mb:.1f} MB keras / ~4 MB int8 TFLite, 521 classes)\n")
    print(f"{'clip':14s} {'ms':>5s}  top-5 labels")
    print("-" * 88)
    yam_ms, snore_hits = [], 0
    for path in files:
        w = load_clip(path)
        t0 = time.perf_counter()
        scores, _, _ = model(w)
        dt = (time.perf_counter() - t0) * 1000
        yam_ms.append(dt)
        mean = scores.numpy().mean(axis=0)
        top = np.argsort(mean)[::-1][:5]
        if names[top[0]] in SNORE_FAMILY:
            snore_hits += 1
        tops = ", ".join(f"{names[i]} {mean[i]:.2f}" for i in top)
        print(f"{os.path.basename(path)[:14]:14s} {dt:5.0f}  {tops}")

    print(f"\nRule-based engine (no model)\n")
    print(f"{'clip':14s} {'ms':>5s}  snore_prob  low_ratio  centroid  f0")
    print("-" * 62)
    rule_ms = []
    for path in files:
        x = load_clip(path)
        ev = analysis.Event(start_s=0, end_s=len(x) / 16000)
        t0 = time.perf_counter()
        analysis._extract_features(x, 16000, ev)
        prob = analysis._snore_probability(ev)
        dt = (time.perf_counter() - t0) * 1000
        rule_ms.append(dt)
        print(f"{os.path.basename(path)[:14]:14s} {dt:5.1f}  {prob:9.2f}"
              f"  {ev.low_band_ratio:8.2f}  {ev.centroid_hz:7.0f}  {ev.f0_hz:4.0f}")

    print(f"\nmean latency / clip (CPU): YAMNet {np.mean(yam_ms):.0f} ms | "
          f"rule-based {np.mean(rule_ms):.1f} ms")
    print(f"YAMNet snore-family top-1 on {snore_hits}/{len(files)} clips")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument("--clips", required=True, help="folder of audio clips to classify")
    ap.add_argument("--model-dir", default=os.path.join(here, "model"),
                    help="folder with yamnet.py/params.py/yamnet.h5/yamnet_class_map.csv")
    args = ap.parse_args()
    run(args.clips, args.model_dir)
