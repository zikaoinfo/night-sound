# Sound-labelling benchmark

Decision #4: beyond "snore vs. not", label night sounds (snore, cough, speech,
gasp, pet…) with a **lightweight, fully on-device (serverless)** classifier.

## Recommended design — two-stage, on-device

```
mic ─▶ rule-based engine (cheap)  ─▶ event?  ─▶ classifier on the clip (only on events)
       envelope + spectral + rhythm                  ├─ iOS: Apple SoundAnalysis (built in)
       ~8 ms / clip                                   └─ Android: YAMNet TFLite (~4 MB)
```

Run the expensive classifier **only on detected events**, never on the whole
night. The rule engine stays the fast gate; the classifier adds the label.

## Candidates

| Option | On-device | Size to ship | Snoring class? | Platform | Notes |
|--------|:---:|---|:---:|---|---|
| **Apple SoundAnalysis** | ✅ | **0 MB** (OS built-in) | ✅ (300+ sounds) | iOS/macOS only | Zero model to bundle or train. Best iOS path. |
| **YAMNet (TFLite)** | ✅ | ~4 MB (int8) | ✅ (521 AudioSet) | iOS + **Android** | Best cross-platform default. Benchmarked below. |
| PANNs (CNN14) | ✅ | ~80–300 MB | ✅ | any | More accurate, too heavy for mobile v1. |
| AST / transformers | ✅ | 80 MB+ | ✅ | any | Accurate, heavy, slower. |
| Edge Impulse (custom) | ✅ | tiny | you label it | any | Train a snore-specialised tiny model later. |
| Cloud APIs | ❌ | — | varies | — | Rejected: not serverless/private. |

**Pick:** Apple SoundAnalysis on iOS (free, built-in), YAMNet-TFLite on Android.

## Benchmark run (this repo, CPU)

`classify_bench.py` on 7 clips, YAMNet vs. our rule engine:

- **Latency:** YAMNet **~93 ms/clip**, rule-based **~8 ms/clip** (both per-event,
  not per-frame → both easily real-time on a phone).
- **Model size:** YAMNet 15.3 MB (Keras weights) / ~4 MB as int8 TFLite.
- **Feasibility:** confirmed — loads and runs clean.

### Honest caveat (important)

The run above used **synthetic** clips, and YAMNet labelled them "Music" /
"Noise", not "Snoring" — because it is trained on real recordings and synthetic
tones don't match real snore timbre. Our rule engine scored the same synthetic
snores high, but that's partly circular (the synth was built around the same
spectral assumptions).

**Conclusion:** a benchmark that decides accuracy needs **real, labelled
recordings**. That's Phase 3 of `PLAN.md`. The harness here is ready — point
`--clips` at a folder of your real labelled clips (snore / cough / speech /
quiet …) and it reports exactly how YAMNet and the rule engine each do.

## Run it

See the header of `classify_bench.py` for the model-download commands, then:

```bash
TF_USE_LEGACY_KERAS=1 python bench/classify_bench.py --clips path/to/real_clips
```

The YAMNet model files (`bench/model/`, incl. the 15 MB `yamnet.h5`) are
git-ignored — download them with the commands in the script header.
