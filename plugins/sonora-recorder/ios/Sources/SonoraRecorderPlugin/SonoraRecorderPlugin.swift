import AVFoundation
import Capacitor
import Foundation

/// JS name: `SonoraRecorder`.
///   start({ sensitivity?, fullRecording?, keepClips? }) -> { sessionId }
///   stop() -> session
///   status() -> { recording, sessionId?, elapsedS?, events?, snores?, noiseFloorDbfs? }
///   listSessions() -> { sessions: [summary] }
///   getSession({ id }) -> session
///   deleteSession({ id })
/// Events: "soundEvent" (one detected event), "level" (~4 Hz loudness).
/// Session objects carry `baseUrl` (file URL of the session folder) so the web
/// layer can play clips via Capacitor.convertFileSrc(baseUrl + clip).
@objc(SonoraRecorderPlugin)
public class SonoraRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SonoraRecorderPlugin"
    public let jsName = "SonoraRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSessions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeShareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSessionFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pausePlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumePlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekPlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeCommand", returnType: CAPPluginReturnPromise),
    ]

    private let recorder = NightRecorder()
    private let player = ClipPlayer()

    override public func load() {
        recorder.onEvent = { [weak self] ev in
            self?.notifyListeners("soundEvent", data: Self.object(ev))
        }
        recorder.onLevel = { [weak self] level in
            self?.notifyListeners("level", data: level)
        }
        player.isRecording = { [weak self] in self?.recorder.isRecording ?? false }
        player.onState = { [weak self] state in
            self?.notifyListeners("playback", data: state)
        }
        // Siri / Shortcuts ("Start sleep", "Wake up") — see native/ios/SonoraIntents.swift.
        NotificationCenter.default.addObserver(forName: Notification.Name("SonoraCommand"),
                                               object: nil, queue: .main) { [weak self] _ in
            guard let self, let command = Self.popCommand() else { return }
            self.notifyListeners("command", data: ["command": command], retainUntilConsumed: true)
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let opts = RecorderOptions(
            sensitivity: call.getString("sensitivity", "normal"),
            fullRecording: call.getBool("fullRecording", false),
            keepClips: call.getBool("keepClips", true),
            tags: call.getArray("tags", String.self) ?? [],
            startDelayS: call.getDouble("startDelayS", 0))
        Self.requestMicrophone { granted in
            guard granted else {
                call.reject("Microphone access is off. Turn it on in Settings > Sonora.", "PERMISSION_DENIED")
                return
            }
            DispatchQueue.main.async {
                self.player.stop()
                do {
                    call.resolve(["sessionId": try self.recorder.start(opts)])
                } catch {
                    call.reject("Could not start recording: \(error.localizedDescription)", "START_FAILED", error)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let result = self.recorder.stop() else {
                call.reject("Nothing is recording.", "NOT_RECORDING")
                return
            }
            call.resolve(Self.sessionObject(result.0, result.1))
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve(recorder.status())
    }

    @objc func listSessions(_ call: CAPPluginCall) {
        let sessions: [[String: Any]] = NightRecorder.list().map { rec in
            var o = Self.object(rec.summary)
            o["id"] = rec.id
            o["startedAt"] = rec.startedAt
            o["endedAt"] = rec.endedAt ?? NSNull()
            o["durationS"] = rec.durationS
            o["eventCount"] = rec.events.count
            if let meta = rec.meta { o["meta"] = Self.object(meta) }
            return o
        }
        call.resolve(["sessions": sessions])
    }

    @objc func getSession(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let found = NightRecorder.load(id: id) else {
            call.reject("Session not found.", "NOT_FOUND")
            return
        }
        call.resolve(Self.sessionObject(found.0, found.1))
    }

    @objc func deleteSession(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing id.", "BAD_REQUEST")
            return
        }
        do {
            try NightRecorder.delete(id: id)
            call.resolve()
        } catch {
            call.reject("Could not delete session.", "DELETE_FAILED", error)
        }
    }

    /// updateSession({ id, tags, rating?, note? })
    @objc func updateSession(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("Missing id.", "BAD_REQUEST")
            return
        }
        let meta = NightMeta(tags: call.getArray("tags", String.self) ?? [],
                             rating: call.getInt("rating"), note: call.getString("note"))
        if recorder.updateMeta(id: id, meta: meta) {
            call.resolve()
        } else {
            call.reject("Session not found.", "NOT_FOUND")
        }
    }

    /// importSession({ json }) -> { result: "added" | "exists" }
    @objc func importSession(_ call: CAPPluginCall) {
        guard let json = call.getString("json")?.data(using: .utf8) else {
            call.reject("Missing json.", "BAD_REQUEST")
            return
        }
        switch NightRecorder.importSession(json: json) {
        case .added: call.resolve(["result": "added"])
        case .exists: call.resolve(["result": "exists"])
        case .invalid: call.reject("That doesn't look like a Sonora night.", "INVALID")
        }
    }

    /// writeShareFile({ name, data (base64) }) -> { uri }: a file in Caches/share
    /// for the Share plugin (reports, clips, backups).
    @objc func writeShareFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"),
              name.range(of: #"^[A-Za-z0-9._-]{1,100}$"#, options: .regularExpression) != nil,
              let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("Missing or invalid file.", "BAD_REQUEST")
            return
        }
        do {
            let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("share", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(name)
            try data.write(to: url, options: .atomic)
            call.resolve(["uri": url.absoluteString])
        } catch {
            call.reject("Could not write the file.", "WRITE_FAILED", error)
        }
    }

    // MARK: playback and session files

    /// A file inside a stored night: "full.m4a" or "clips/clip-00001.wav".
    private func sessionFile(_ call: CAPPluginCall) -> URL? {
        guard let id = call.getString("id"), let file = call.getString("file"),
              id.range(of: #"^\d{8}-\d{6}$"#, options: .regularExpression) != nil,
              file.range(of: #"^(full\.m4a|clips/clip-\d{5}\.wav)$"#, options: .regularExpression) != nil
        else { return nil }
        let url = NightRecorder.root.appendingPathComponent(id).appendingPathComponent(file)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// playFile({ id, file, at? }) — "playback" events report progress.
    @objc func playFile(_ call: CAPPluginCall) {
        guard let url = sessionFile(call) else {
            call.reject("That recording isn't on this phone any more.", "NOT_FOUND")
            return
        }
        let tag: [String: Any] = ["id": call.getString("id") ?? "", "file": call.getString("file") ?? ""]
        let at = call.getDouble("at", 0)
        DispatchQueue.main.async {
            do {
                try self.player.play(url: url, at: at, tag: tag)
                call.resolve()
            } catch {
                call.reject("Couldn't play it: \(error.localizedDescription)", "PLAY_FAILED", error)
            }
        }
    }

    @objc func pausePlayback(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.player.pause(); call.resolve() }
    }

    @objc func resumePlayback(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.player.resume(); call.resolve() }
    }

    @objc func seekPlayback(_ call: CAPPluginCall) {
        let t = call.getDouble("t", 0)
        DispatchQueue.main.async { self.player.seek(to: t); call.resolve() }
    }

    @objc func stopPlayback(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.player.stop(); call.resolve() }
    }

    /// readSessionFile({ id, file }) -> { data (base64) } — clips for the report.
    @objc func readSessionFile(_ call: CAPPluginCall) {
        guard let url = sessionFile(call), let data = try? Data(contentsOf: url) else {
            call.reject("File not found.", "NOT_FOUND")
            return
        }
        call.resolve(["data": data.base64EncodedString()])
    }

    // MARK: Siri / Shortcuts commands

    private static let commandKey = "sonora.pendingCommand"

    private static func popCommand() -> String? {
        let d = UserDefaults.standard
        guard let c = d.string(forKey: commandKey) else { return nil }
        d.removeObject(forKey: commandKey)
        return c
    }

    /// takeCommand() -> { command: "startSleep" | "wakeUp" | null }: a command
    /// that arrived before the web app was listening (cold start from Siri).
    @objc func takeCommand(_ call: CAPPluginCall) {
        call.resolve(["command": Self.popCommand() ?? NSNull()])
    }

    // MARK: helpers

    private static func requestMicrophone(_ done: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: done)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(done)
        }
    }

    private static func sessionObject(_ rec: SessionRecord, _ dir: URL) -> [String: Any] {
        var o = object(rec)
        o["baseUrl"] = dir.absoluteString
        return o
    }

    private static func object<T: Encodable>(_ value: T) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(value),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return obj
    }
}
