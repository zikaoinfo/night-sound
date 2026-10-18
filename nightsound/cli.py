"""Command-line interface.

    python -m nightsound analyse recording.m4a
    python -m nightsound analyse recording.m4a --clips episodes -o out/
    python -m nightsound demo            # build + analyse a synthetic night
"""

from __future__ import annotations

import argparse
import os
import sys

from . import analysis, report, synth


def _run_analyse(args: argparse.Namespace) -> int:
    if not os.path.exists(args.input):
        print(f"error: file not found: {args.input}", file=sys.stderr)
        return 2

    def progress(msg: str) -> None:
        if not args.quiet:
            print(f"  … {msg}", file=sys.stderr)

    rep = analysis.analyse(
        args.input, snore_threshold=args.threshold, progress=progress,
    )
    print(report.text_summary(rep))

    outdir = args.out or "."
    os.makedirs(outdir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(args.input))[0]

    if not args.no_json:
        jp = os.path.join(outdir, f"{stem}.report.json")
        report.write_json(rep, jp)
        print(f"\n JSON report  -> {jp}")
    if not args.no_plot:
        pp = os.path.join(outdir, f"{stem}.timeline.png")
        report.write_timeline(rep, pp)
        print(f" Timeline PNG -> {pp}")
    if args.clips:
        clips = report.extract_clips(rep, args.input, os.path.join(outdir, "clips"),
                                     what=args.clips)
        print(f" Clips ({args.clips}) -> {len(clips)} file(s) in {outdir}/clips/")
    return 0


def _run_demo(args: argparse.Namespace) -> int:
    outdir = args.out or "."
    os.makedirs(outdir, exist_ok=True)
    wav = os.path.join(outdir, "synthetic_night.wav")
    print(f"building synthetic night ({args.minutes:.0f} min) -> {wav}", file=sys.stderr)
    synth.make_night(wav, minutes=args.minutes)
    ns = argparse.Namespace(
        input=wav, threshold=args.threshold, quiet=args.quiet, out=outdir,
        no_json=False, no_plot=False, clips="episodes",
    )
    return _run_analyse(ns)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="nightsound",
        description="Detect and analyse snoring and other night-time sounds.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("analyse", aliases=["analyze"], help="analyse an audio file")
    a.add_argument("input", help="audio file (.m4a/.mp3/.wav/.opus/...)")
    a.add_argument("-o", "--out", help="output directory (default: cwd)")
    a.add_argument("-t", "--threshold", type=float, default=0.5,
                   help="snore probability cutoff, 0..1 (default 0.5)")
    a.add_argument("--clips", choices=["episodes", "snores", "weird"],
                   help="also extract review clips")
    a.add_argument("--no-json", action="store_true")
    a.add_argument("--no-plot", action="store_true")
    a.add_argument("-q", "--quiet", action="store_true")
    a.set_defaults(func=_run_analyse)

    d = sub.add_parser("demo", help="generate + analyse a synthetic night")
    d.add_argument("-o", "--out", default="demo_out", help="output directory")
    d.add_argument("--minutes", type=float, default=5.0)
    d.add_argument("-t", "--threshold", type=float, default=0.5)
    d.add_argument("-q", "--quiet", action="store_true")
    d.set_defaults(func=_run_demo)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
