"""Audio I/O built on ffmpeg.

We lean on ffmpeg rather than a Python codec library so that phone
recordings (.m4a / AAC, .opus, .mp3, ...) all decode the same way, and so
that an 8-hour file can be streamed in chunks instead of loaded whole.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Iterator

import numpy as np

TARGET_SR = 16_000  # snoring energy lives well below 8 kHz; 16 kHz is plenty.


def _require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg not found on PATH. Install it (e.g. `apt install ffmpeg` "
            "or `brew install ffmpeg`) — it is used to decode audio."
        )


@dataclass
class AudioInfo:
    duration_s: float
    sample_rate: int
    channels: int
    codec: str


def probe(path: str) -> AudioInfo:
    """Read basic stream metadata with ffprobe."""
    _require_ffmpeg()
    if shutil.which("ffprobe") is None:
        raise RuntimeError("ffprobe not found on PATH (ships with ffmpeg).")
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
            "-of", "json", path,
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    return AudioInfo(
        duration_s=float(fmt.get("duration", 0.0) or 0.0),
        sample_rate=int(stream.get("sample_rate", 0) or 0),
        channels=int(stream.get("channels", 0) or 0),
        codec=str(stream.get("codec_name", "?")),
    )


def stream_mono(path: str, sr: int = TARGET_SR, chunk_s: float = 30.0) -> Iterator[np.ndarray]:
    """Yield float32 mono samples in [-1, 1], chunk by chunk, resampled to `sr`."""
    _require_ffmpeg()
    chunk_bytes = int(sr * chunk_s) * 4  # float32 == 4 bytes
    proc = subprocess.Popen(
        [
            "ffmpeg", "-v", "error", "-i", path,
            "-ac", "1", "-ar", str(sr),
            "-f", "f32le", "-acodec", "pcm_f32le", "-",
        ],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(chunk_bytes)
            if not buf:
                break
            yield np.frombuffer(buf, dtype="<f4")
    finally:
        if proc.stdout:
            proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace") if proc.stderr else ""
        ret = proc.wait()
        if ret != 0:
            raise RuntimeError(f"ffmpeg failed to decode {path!r}:\n{err.strip()}")


def read_region(path: str, start_s: float, dur_s: float, sr: int = TARGET_SR) -> np.ndarray:
    """Decode a single short region (sample-accurate) to float32 mono."""
    _require_ffmpeg()
    proc = subprocess.run(
        [
            "ffmpeg", "-v", "error",
            "-i", path, "-ss", f"{max(0.0, start_s):.3f}", "-t", f"{max(0.0, dur_s):.3f}",
            "-ac", "1", "-ar", str(sr),
            "-f", "f32le", "-acodec", "pcm_f32le", "-",
        ],
        capture_output=True, check=True,
    )
    return np.frombuffer(proc.stdout, dtype="<f4").copy()
