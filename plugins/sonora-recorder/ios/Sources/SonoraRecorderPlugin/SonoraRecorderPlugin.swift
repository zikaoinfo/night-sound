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
    ]

    private let recorder = NightRecorder()

    override public func load() {
        recorder.onEvent = { [weak self] ev in
            self?.notifyListeners("soundEvent", data: Self.object(ev))
        }
        recorder.onLevel = { [weak self] level in
            self?.notifyListeners("level", data: level)
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
