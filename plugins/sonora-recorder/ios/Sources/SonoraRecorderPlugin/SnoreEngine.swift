import Accelerate
import Foundation

/// One detected sound event. Field names match web/analyzer.js so the UI
/// renders native and web sessions the same way.
struct SonoraEvent: Codable {
    var startS: Double
    var endS: Double
    var durationS: Double
    var peakDbfs: Double
    var centroid: Double
    var lowRatio: Double
    var flatness: Double
    var f0: Double
    var harmonicity: Double
    var snoreProb: Double
    var isSnore: Bool
    var intensity: String
    var clip: String?
}

struct SessionSummary: Codable {
    var snoreEvents = 0
    var snoreTimeS = 0.0
    var snorePercent = 0.0
    var snoresPerHour = 0.0
    var snoreScore = 0.0
    var episodes = 0
    var weirdSounds = 0
}

/// Streaming snore detector on 16 kHz mono audio. Same pipeline and
/// constants as nightsound/analysis.py and web/analyzer.js:
/// loudness envelope -> adaptive noise floor -> events -> spectral features
/// -> snore probability. Not thread-safe; feed it from one queue.
final class SnoreEngine {
    static let sampleRate = 16_000
    static let frameS = 0.05
    static let hop = 800                       // 50 ms at 16 kHz

    var snoreThreshold = 0.5
    var threshOverFloorDb = 9.0
    let absFloorDbfs = -55.0
    let noisePctl = 0.20
    let minEventS = 0.20
    let mergeGapS = 0.35
    let maxEventS = 8.0
    let prerollS = 0.5
    let noiseWindowFrames = Int(90.0 / 0.05)

    private(set) var noiseFloor = -50.0
    private(set) var frameIndex = 0
    private(set) var envelope: [Float] = []   // loudest frame of each second, dBFS
    private(set) var lastDb = -120.0

    private var pending: [Float] = []
    private var recentDb: [Double] = []
    private var recentPos = 0
    private var secondMax = -120.0

    private var inEvent = false
    private var evStartFrame = 0
    private var evLastAbove = 0
    private var evPeakDb = -120.0
    private var evSamples: [Float] = []
    private var evPreroll: [Float] = []
    private var preroll: [Float] = []

    /// Called for each finished event with its clip samples (pre-roll + event).
    var onEvent: ((SonoraEvent, [Float]) -> Void)?

    var threshold: Double { max(noiseFloor + threshOverFloorDb, absFloorDbfs) }
    var elapsedS: Double { Double(frameIndex) * Self.frameS }

    func process(_ samples: [Float]) {
        pending.append(contentsOf: samples)
        var offset = 0
        while pending.count - offset >= Self.hop {
            processFrame(Array(pending[offset..<offset + Self.hop]))
            offset += Self.hop
        }
        if offset > 0 { pending.removeFirst(offset) }
    }

    func flush() {
        if inEvent { finishEvent(endFrame: evLastAbove + 1) }
    }

    private func processFrame(_ frame: [Float]) {
        var meanSquare: Float = 0
        vDSP_measqv(frame, 1, &meanSquare, vDSP_Length(frame.count))
        let db = 10.0 * log10(Double(meanSquare) + 1e-20)   // == 20·log10(rms)
        lastDb = db
        updateNoiseFloor(db)

        secondMax = max(secondMax, db)
        if (frameIndex + 1) % 20 == 0 {
            envelope.append(Float(secondMax))
            secondMax = -120
        }

        if db >= threshold {
            if !inEvent {
                inEvent = true
                evStartFrame = frameIndex
                evPeakDb = db
                evSamples.removeAll(keepingCapacity: true)
                evPreroll = preroll
            }
            evLastAbove = frameIndex
            evPeakDb = max(evPeakDb, db)
            evSamples.append(contentsOf: frame)
            if Double(frameIndex + 1 - evStartFrame) * Self.frameS >= maxEventS {
                finishEvent(endFrame: frameIndex + 1)    // split very long runs
            }
        } else if inEvent {
            evSamples.append(contentsOf: frame)
            if Double(frameIndex - evLastAbove) * Self.frameS > mergeGapS {
                finishEvent(endFrame: evLastAbove + 1)
            }
        }

        preroll.append(contentsOf: frame)
        let maxPreroll = Int(prerollS * Double(Self.sampleRate))
        if preroll.count > maxPreroll { preroll.removeFirst(preroll.count - maxPreroll) }
        frameIndex += 1
    }

    private func updateNoiseFloor(_ db: Double) {
        if recentDb.count < noiseWindowFrames {
            recentDb.append(db)
        } else {
            recentDb[recentPos] = db
            recentPos = (recentPos + 1) % noiseWindowFrames
        }
        if recentDb.count >= 20 && frameIndex % 20 == 0 {
            let sorted = recentDb.sorted()
            noiseFloor = sorted[Int(Double(sorted.count - 1) * noisePctl)]
        }
    }

    private func finishEvent(endFrame: Int) {
        inEvent = false
        let frames = endFrame - evStartFrame
        let durationS = Double(frames) * Self.frameS
        guard durationS >= minEventS else { return }
        let x = Array(evSamples.prefix(frames * Self.hop))

        let f = SpectralFeatures(x)
        var ev = SonoraEvent(
            startS: Double(evStartFrame) * Self.frameS,
            endS: Double(endFrame) * Self.frameS,
            durationS: durationS,
            peakDbfs: evPeakDb,
            centroid: f.centroid, lowRatio: f.lowRatio, flatness: f.flatness,
            f0: f.f0, harmonicity: f.harmonicity,
            snoreProb: 0, isSnore: false, intensity: "quiet", clip: nil)
        ev.snoreProb = Self.snoreProbability(ev)
        ev.isSnore = ev.snoreProb >= snoreThreshold
        ev.intensity = Self.intensity(peak: evPeakDb, floor: noiseFloor)
        onEvent?(ev, evPreroll + x)
    }

    // MARK: scoring (keep in step with web/analyzer.js)

    static func snoreProbability(_ e: SonoraEvent) -> Double {
        func clamp(_ v: Double) -> Double { max(0, min(1, v)) }
        var s = 0.0
        s += 0.32 * clamp((e.lowRatio - 0.45) / 0.45)
        s += 0.22 * clamp((900 - e.centroid) / 700)
        s += 0.18 * clamp((0.55 - e.flatness) / 0.45)
        s += 0.16 * clamp((e.harmonicity - 0.2) / 0.5)
        let d = e.durationS
        s += 0.12 * ((d >= 0.3 && d <= 3.0) ? 1 : max(0, 1 - abs(d - 1.5) / 3.0))
        return clamp(s)
    }

    static func intensity(peak: Double, floor: Double) -> String {
        let over = peak - floor
        if over < 10 { return "quiet" }
        if over < 20 { return "light" }
        if over < 30 { return "loud" }
        return "epic"
    }

    /// A snore candidate outside any rhythmic run needs at least this probability.
    static let loneSnoreMin = 0.65

    /// Indices of snore candidates in rhythmic runs (>= 3 at breathing rate),
    /// and how many runs there are.
    static func episodeMembers(_ events: [SonoraEvent]) -> (members: Set<Int>, episodes: Int) {
        var members = Set<Int>()
        var episodes = 0
        var run: [Int] = []
        func flush() {
            if run.count >= 3 { members.formUnion(run); episodes += 1 }
            run = []
        }
        for (i, e) in events.enumerated() where e.isSnore {
            if let last = run.last, (1.5...6.0).contains(e.startS - events[last].startS) {
                run.append(i)
            } else {
                flush()
                run = [i]
            }
        }
        flush()
        return (members, episodes)
    }

    static func summarize(events: [SonoraEvent], durationS: Double) -> SessionSummary {
        var s = SessionSummary()
        let (members, episodes) = episodeMembers(events)
        let confirmed = Set(events.indices.filter {
            events[$0].isSnore && (members.contains($0) || events[$0].snoreProb >= loneSnoreMin)
        })
        let snores = confirmed.sorted().map { events[$0] }
        s.episodes = episodes
        s.snoreEvents = snores.count
        s.snoreTimeS = snores.reduce(0) { $0 + $1.durationS }
        s.snorePercent = durationS > 0 ? 100 * s.snoreTimeS / durationS : 0
        s.snoresPerHour = durationS > 0 ? Double(snores.count) / (durationS / 3600) : 0
        let loud = snores.filter { $0.intensity == "loud" }.count
        let epic = snores.filter { $0.intensity == "epic" }.count
        let loudFrac = snores.isEmpty ? 0 : (0.5 * Double(loud) + Double(epic)) / Double(snores.count)
        s.snoreScore = 100 * (0.65 * min(s.snorePercent, 60) / 60 + 0.35 * loudFrac)
        s.weirdSounds = events.indices.filter {
            !confirmed.contains($0) && (events[$0].intensity == "loud" || events[$0].intensity == "epic")
        }.count
        return s
    }

    static func wav(_ samples: [Float], sampleRate: Int = SnoreEngine.sampleRate) -> Data {
        var d = Data()
        func ascii(_ s: String) { d.append(s.data(using: .ascii)!) }
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let dataBytes = UInt32(samples.count * 2)
        ascii("RIFF"); u32(36 + dataBytes); ascii("WAVE")
        ascii("fmt "); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        ascii("data"); u32(dataBytes)
        let pcm = samples.map { Int16(max(-1, min(1, $0)) * 32767).littleEndian }
        pcm.withUnsafeBufferPointer { d.append($0) }
        return d
    }
}

/// Spectral shape of one event: averaged 512-point Hann-windowed power
/// spectrum (50% overlap), plus an autocorrelation f0 estimate.
struct SpectralFeatures {
    var centroid = 0.0
    var lowRatio = 0.0
    var flatness = 1.0
    var f0 = 0.0
    var harmonicity = 0.0

    init(_ x: [Float], sampleRate: Int = SnoreEngine.sampleRate) {
        guard !x.isEmpty else { return }
        let n = 512, half = 256
        let log2n = vDSP_Length(9)
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return }
        defer { vDSP_destroy_fftsetup(setup) }

        var window = [Float](repeating: 0, count: n)
        vDSP_hann_window(&window, vDSP_Length(n), Int32(vDSP_HANN_NORM))
        let realp = UnsafeMutablePointer<Float>.allocate(capacity: half)
        let imagp = UnsafeMutablePointer<Float>.allocate(capacity: half)
        defer { realp.deallocate(); imagp.deallocate() }
        var split = DSPSplitComplex(realp: realp, imagp: imagp)

        var power = [Double](repeating: 0, count: half)
        var buf = [Float](repeating: 0, count: n)
        var frames = 0
        for start in stride(from: 0, to: max(x.count - half, 1), by: half) {
            for i in 0..<n {
                let j = start + i
                buf[i] = j < x.count ? x[j] * window[i] : 0
            }
            buf.withUnsafeBytes { raw in
                vDSP_ctoz(raw.bindMemory(to: DSPComplex.self).baseAddress!, 2, &split, 1, vDSP_Length(half))
            }
            vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
            power[0] += Double(realp[0] * realp[0])          // imagp[0] holds Nyquist
            for k in 1..<half {
                power[k] += Double(realp[k] * realp[k] + imagp[k] * imagp[k])
            }
            frames += 1
        }

        var band = 1e-12, low = 0.0, cen = 0.0, logSum = 0.0, count = 0.0
        for k in 0..<half {
            let hz = Double(k) * Double(sampleRate) / Double(n)
            guard hz >= 30, hz <= 4000 else { continue }
            let p = power[k] / Double(frames)
            band += p; cen += hz * p; logSum += log(p + 1e-20); count += 1
            if hz <= 600 { low += p }
        }
        centroid = cen / band
        lowRatio = low / band
        flatness = count > 0 ? exp(logSum / count) / (band / count) : 1
        (f0, harmonicity) = Self.estimateF0(x, sampleRate: sampleRate)
    }

    /// Fundamental via autocorrelation over 40–400 Hz on at most 1 s of the event.
    static func estimateF0(_ x: [Float], sampleRate: Int) -> (Double, Double) {
        guard x.count >= sampleRate / 20 else { return (0, 0) }
        let start = max(0, (x.count - sampleRate) / 2)
        let raw = Array(x[start..<min(x.count, start + sampleRate)])
        var mean: Float = 0
        vDSP_meanv(raw, 1, &mean, vDSP_Length(raw.count))
        let seg = raw.map { $0 - mean }

        var ac0: Float = 0
        vDSP_dotpr(seg, 1, seg, 1, &ac0, vDSP_Length(seg.count))
        let lo = sampleRate / 400, hi = min(sampleRate / 40, seg.count - 1)
        guard ac0 > 0, hi > lo else { return (0, 0) }

        var best: Float = -.infinity
        var bestLag = 0
        seg.withUnsafeBufferPointer { p in
            let base = p.baseAddress!
            for lag in lo...hi {
                var s: Float = 0
                vDSP_dotpr(base, 1, base + lag, 1, &s, vDSP_Length(seg.count - lag))
                if s > best { best = s; bestLag = lag }
            }
        }
        let h = Double(max(0, min(1, best / ac0)))
        let f0 = bestLag > 0 ? Double(sampleRate) / Double(bestLag) : 0
        return (h > 0.15 ? f0 : 0, h)
    }
}
