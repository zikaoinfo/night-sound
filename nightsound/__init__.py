"""night-sound: detect and analyse snoring and other night-time sounds.

A dependency-light analysis engine. Give it an overnight recording in any
format ffmpeg can read (.m4a, .mp3, .wav, .opus, ...) and it returns a
structured report: when you snored, how loud, how often, plus a list of
other "weird" sounds in the night.
"""

__version__ = "0.1.0"

from .analysis import analyse, Event, SessionReport  # noqa: E402,F401

__all__ = ["analyse", "Event", "SessionReport", "__version__"]
