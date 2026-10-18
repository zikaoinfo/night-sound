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


def test_one_off_sounds_are_not_snores():
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        # exactly the 9 + 14 + 11 planted snores; the cough, thud and mumble
        # are reported as other loud sounds, not snores
        assert rep.snore_events == 34, rep.snore_events
        starts = sorted(round(w["start_s"]) for w in rep.weird_sounds)
        assert starts == [60, 150, 240], starts


def test_score_stays_in_range():
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        assert 0 < rep.snore_score <= 100, rep.snore_score


def test_evaluate_on_labelled_clips():
    from nightsound import evaluate, report
    with tempfile.TemporaryDirectory() as tmp:
        wav = _build(tmp)
        rep = analyse(wav)
        clips = report.extract_clips(rep, wav, os.path.join(tmp, "clips"), what="all")
        labelled = os.path.join(tmp, "labelled")
        for ev, path in zip(rep.events, clips):
            folder = os.path.join(labelled, "snore" if ev.in_episode else "other")
            os.makedirs(folder, exist_ok=True)
            os.rename(path, os.path.join(folder, os.path.basename(path)))
        text = evaluate.report(labelled)
        assert "Suggested snore threshold" in text, text


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        rep = analyse(_build(tmp))
        print("episodes:", len(rep.episodes),
              "snores:", rep.snore_events,
              "score:", rep.snore_score)
        assert len(rep.episodes) == 3
        print("OK")
