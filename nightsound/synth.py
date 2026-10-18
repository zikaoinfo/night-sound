"""Generate a synthetic night recording for testing and demos.

Not a substitute for real audio — just a controllable signal with known
snoring episodes and a few one-off sounds, so the engine can be exercised
without a microphone.
"""

from __future__ import annotations

import subprocess
import numpy as np

SR = 16_000


def _snore_burst(dur_s: float, f0: float, rng: np.random.Generator) -> np.ndarray:
    """One snore: a low harmonic tone with a turbulent rattle and soft envelope."""
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for k, amp in enumerate([1.0, 0.6, 0.35, 0.2, 0.12], start=1):
        sig += amp * np.sin(2 * np.pi * f0 * k * t + rng.uniform(0, np.pi))
    # turbulence: band-limited noise rising on the inhale
    noise = rng.standard_normal(n) * 0.25
    sig = sig / np.max(np.abs(sig)) + noise
    # amplitude envelope with a slow tremolo (the rattle)
    env = np.sin(np.pi * t / dur_s) ** 1.3
    env *= 0.7 + 0.3 * np.sin(2 * np.pi * 6.0 * t)
    return (sig * env).astype(np.float32)


def _broadband(dur_s: float, centre: float, rng: np.random.Generator) -> np.ndarray:
    """A short non-snore sound (cough / thud / speech-ish) centred near `centre` Hz."""
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    sig = rng.standard_normal(n)
    sig += 1.5 * np.sin(2 * np.pi * centre * t)
    env = np.exp(-t / (dur_s * 0.4))
    return (sig / np.max(np.abs(sig)) * env).astype(np.float32)


def make_night(out_path: str, minutes: float = 5.0, seed: int = 7) -> str:
    """Write a synthetic WAV and return its path."""
    rng = np.random.default_rng(seed)
    n = int(minutes * 60 * SR)
    track = (rng.standard_normal(n) * 0.004).astype(np.float32)  # quiet room floor

    def place(clip: np.ndarray, at_s: float, gain: float) -> None:
        i = int(at_s * SR)
        j = min(i + clip.size, n)
        track[i:j] += gain * clip[: j - i]

    # three snoring episodes at different times / loudness
    for ep_start, breaths, period, gain, f0 in [
        (20.0, 9, 3.4, 0.30, 110.0),
        (90.0, 14, 3.0, 0.55, 95.0),
        (180.0, 11, 3.6, 0.40, 130.0),
    ]:
        t = ep_start
        for _ in range(breaths):
            dur = rng.uniform(1.0, 1.8)
            place(_snore_burst(dur, f0 + rng.uniform(-8, 8), rng), t,
                  gain * rng.uniform(0.85, 1.15))
            t += period + rng.uniform(-0.4, 0.4)

    # a few one-off "weird" sounds
    place(_broadband(0.4, 500, rng), 60.0, 0.5)    # cough
    place(_broadband(0.3, 120, rng), 150.0, 0.6)   # thud / door
    place(_broadband(0.9, 350, rng), 240.0, 0.35)  # mumble / speech-ish

    track = np.clip(track, -1.0, 1.0)
    # write via ffmpeg from raw f32 so we depend on nothing but ffmpeg
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1",
         "-i", "-", out_path],
        input=track.tobytes(), check=True,
    )
    _ = proc
    return out_path
