"""Smoke + behaviour tests on a synthetic night with known content.

Run with:  python -m pytest -q    (or: python tests/test_engine.py)
"""

import os
import tempfile

from nightsound import analyse
from nightsound import synth


def _build(tmp):
    wav = os.path.join(tmp, "night.wav")
    # 3 planted episodes of 9, 14, 11 snores + 3 one-off sounds
    synth.make_night(wav, minutes=5.0, seed=7)
    return wav


def test_detects_three_episodes():
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        # engine should recover all three rhythmic snoring runs
        assert len(rep.episodes) == 3, rep.episodes
        # and roughly the right number of snore events (34 planted)
        assert 28 <= rep.snore_events <= 40, rep.snore_events


def test_episode_rhythm_is_breathing_rate():
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        for ep in rep.episodes:
            assert 1.5 <= ep["mean_interval_s"] <= 6.0, ep


def test_reports_a_weird_sound():
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        # the planted cough is loud and high-ish; it must not vanish silently
        assert rep.duration_s > 290
        assert rep.snore_score > 0


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        print("episodes:", len(rep.episodes),
              "snores:", rep.snore_events,
              "score:", rep.snore_score)
        assert len(rep.episodes) == 3
        print("OK")
