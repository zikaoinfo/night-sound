import AVFoundation
import Foundation

/// What the user noted about a night: factors/remedies, how rested they feel, a note.
struct NightMeta: Codable {
    var tags: [String] = []
    var rating: Int?
    var note: String?
}

struct SessionRecord: Codable {
    var id: String
    var startedAt: String
    var endedAt: String?
    var durationS: Double
    var noiseFloorDbfs: Double
    var sensitivity: String
    var fullRecording: String?
    var envelope: [Float]
    var events: [SonoraEvent]
    var summary: SessionSummary
    var meta: NightMeta?
}

struct RecorderOptions {
    var sensitivity = "normal"      // low | normal | high
    var fullRecording = false       // opt-in: keep the whole night as AAC
    var keepClips = true
    var tags: [String] = []
}

enum RecorderError: LocalizedError {
    case alreadyRecording, noInput
    var errorDescription: String? {
        switch self {
        case .alreadyRecording: return "A session is already recording."
        case .noInput: return "No microphone input is available."
        }
    }
}

/// Captures the microphone all night with AVAudioEngine. With the `audio`
/// background mode this keeps running while the screen is locked. Audio is
/// converted to 16 kHz mono and fed to SnoreEngine; events, short clips and
/// a per-second loudness envelope are saved under
/// Documents/Sonora/sessions/<id>/.
final class NightRecorder {
    static let maxSnoreClips = 60

    var onEvent: ((SonoraEvent) -> Void)?
    var onLevel: (([String: Any]) -> Void)?

    private let engine = AVAudioEngine()
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000,
                                       channels: 1, interleaved: false)!
    private let queue = DispatchQueue(label: "app.sonora.recorder")
    private var converter: AVAudioConverter?
    private var detector: SnoreEngine?
    private var session: SessionRecord?
    private var sessionDir: URL?
    private var fullFile: AVAudioFile?
    private var options = RecorderOptions()
    private var clipCounter = 0
    private var snoreClips: [(index: Int, peak: Double, file: URL)] = []
    private var lastSave = Date.distantPast
    private var lastLevel = Date.distantPast
    private var observers: [NSObjectProtocol] = []

    static var root: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Sonora/sessions", isDirectory: true)
    }

    var isRecording: Bool { queue.sync { session != nil } }

    // MARK: lifecycle

    func start(_ opts: RecorderOptions) throws -> String {
        guard !isRecording else { throw RecorderError.alreadyRecording }
        options = opts

        let avs = AVAudioSession.sharedInstance()
        // .measurement turns off the system's voice processing / AGC so we
        // hear the room as it is.
        try avs.setCategory(.playAndRecord, mode: .measurement, options: [.mixWithOthers, .defaultToSpeaker])
        try avs.setActive(true)

        let id = Self.idFormatter.string(from: Date())
        let dir = Self.root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("clips"),
                                                withIntermediateDirectories: true)

        let det = SnoreEngine()
        switch opts.sensitivity {
        case "low": det.threshOverFloorDb = 12; det.snoreThreshold = 0.6
        case "high": det.threshOverFloorDb = 6; det.snoreThreshold = 0.4
        default: break
        }
        det.onEvent = { [weak self] ev, clip in self?.handle(event: ev, clip: clip) }

        var fullName: String?
        var file: AVAudioFile?
        if opts.fullRecording {
            fullName = "full.m4a"
            file = try AVAudioFile(
                forWriting: dir.appendingPathComponent(fullName!),
                settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000,
                           AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32_000],
                commonFormat: .pcmFormatFloat32, interleaved: false)
        }

        queue.sync {
            detector = det
            sessionDir = dir
            fullFile = file
            clipCounter = 0
            snoreClips = []
            session = SessionRecord(
                id: id, startedAt: Self.iso.string(from: Date()), endedAt: nil,
                durationS: 0, noiseFloorDbfs: det.noiseFloor, sensitivity: opts.sensitivity,
                fullRecording: fullName, envelope: [], events: [], summary: SessionSummary(),
                meta: NightMeta(tags: opts.tags))
            save()
        }

        try installTap()
        engine.prepare()
        try engine.start()
        observeInterruptions()
        return id
    }

    func stop() -> (SessionRecord, URL)? {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers = []

        var result: (SessionRecord, URL)?
        queue.sync {
            detector?.flush()
            session?.endedAt = Self.iso.string(from: Date())
            save()
            if let s = session, let d = sessionDir { result = (s, d) }
            session = nil
            detector = nil
            fullFile = nil
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return result
    }

    func status() -> [String: Any] {
        queue.sync {
            guard let s = session, let det = detector else { return ["recording": false] }
            return ["recording": true, "sessionId": s.id, "elapsedS": det.elapsedS,
                    "events": s.events.count, "snores": s.events.filter { $0.isSnore }.count,
                    "noiseFloorDbfs": det.noiseFloor]
        }
    }

    // MARK: audio path

    private func installTap() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw RecorderError.noInput }
        converter = AVAudioConverter(from: format, to: target)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            self?.convert(buffer)
        }
    }

    /// Runs on the audio render thread: convert, then hand off to our queue.
    private func convert(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let ch = out.floatChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        queue.async { [weak self] in self?.consume(samples, buffer: out) }
    }

    private func consume(_ samples: [Float], buffer: AVAudioPCMBuffer) {
        guard let det = detector, session != nil else { return }
        det.process(samples)
        try? fullFile?.write(from: buffer)

        let now = Date()
        if now.timeIntervalSince(lastLevel) >= 0.25 {
            lastLevel = now
            onLevel?(["t": det.elapsedS, "db": det.lastDb, "floor": det.noiseFloor,
                      "threshold": det.threshold])
        }
        if now.timeIntervalSince(lastSave) >= 30 { save() }
    }

    /// Runs on `queue` (called from SnoreEngine).
    private func handle(event: SonoraEvent, clip: [Float]) {
        guard var s = session, let dir = sessionDir else { return }
        var ev = event
        let worthAClip = ev.isSnore || ev.intensity != "quiet"
        if options.keepClips && worthAClip {
            let name = String(format: "clips/clip-%05d.wav", clipCounter)
            clipCounter += 1
            let url = dir.appendingPathComponent(name)
            if (try? SnoreEngine.wav(clip).write(to: url)) != nil { ev.clip = name }
        }
        s.events.append(ev)
        let index = s.events.count - 1

        // Keep only the loudest snore clips; one-off "other" sounds always keep theirs.
        if ev.isSnore, ev.clip != nil {
            snoreClips.append((index, ev.peakDbfs, dir.appendingPathComponent(ev.clip!)))
            if snoreClips.count > Self.maxSnoreClips,
               let quietest = snoreClips.indices.min(by: { snoreClips[$0].peak < snoreClips[$1].peak }) {
                let drop = snoreClips.remove(at: quietest)
                try? FileManager.default.removeItem(at: drop.file)
                s.events[drop.index].clip = nil
            }
        }
        session = s
        onEvent?(s.events[index])
    }

    /// Runs on `queue`.
    private func save() {
        guard var s = session, let dir = sessionDir, let det = detector else { return }
        s.durationS = det.elapsedS
        s.noiseFloorDbfs = det.noiseFloor
        s.envelope = det.envelope
        s.summary = SnoreEngine.summarize(events: s.events, durationS: s.durationS)
        session = s
        lastSave = Date()
        if let data = try? JSONEncoder().encode(s) {
            try? data.write(to: dir.appendingPathComponent("session.json"), options: .atomic)
        }
    }

    // MARK: interruptions (calls, alarms, route changes)

    private func observeInterruptions() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification,
                                        object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            self?.restartEngine()
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange,
                                        object: engine, queue: .main) { [weak self] _ in
            self?.restartEngine()
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                        object: nil, queue: .main) { [weak self] _ in
            self?.restartEngine()
        })
    }

    private func restartEngine() {
        guard isRecording else { return }
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(true)
        try? installTap()
        engine.prepare()
        try? engine.start()
    }

    /// Update a night's notes. The live session is changed in memory and
    /// saved right away; any other night is rewritten on disk.
    func updateMeta(id: String, meta: NightMeta) -> Bool {
        let live: Bool = queue.sync {
            guard session?.id == id else { return false }
            session?.meta = meta
            save()
            return true
        }
        if live { return true }
        guard let found = Self.load(id: id) else { return false }
        var rec = found.0
        let dir = found.1
        rec.meta = meta
        guard let data = try? JSONEncoder().encode(rec) else { return false }
        return (try? data.write(to: dir.appendingPathComponent("session.json"), options: .atomic)) != nil
    }

    // MARK: stored sessions

    static func load(id: String) -> (SessionRecord, URL)? {
        let dir = root.appendingPathComponent(id, isDirectory: true)
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("session.json")),
              let rec = try? JSONDecoder().decode(SessionRecord.self, from: data) else { return nil }
        return (rec, dir)
    }

    static func list() -> [SessionRecord] {
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return ids.sorted(by: >).compactMap { load(id: $0)?.0 }
    }

    static func delete(id: String) throws {
        try FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
    }

    static let iso = ISO8601DateFormatter()
    static let idFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f
    }()
}
