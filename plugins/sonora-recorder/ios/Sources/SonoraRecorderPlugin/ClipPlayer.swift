import AVFoundation
import Foundation

/// Plays a night's clip or full recording natively. The WebView's <audio>
/// can't reliably stream app files, and AVAudioPlayer also ignores the silent
/// switch, which is what you want when you press play.
final class ClipPlayer: NSObject, AVAudioPlayerDelegate {
    /// state: "playing" | "paused" | "ended" | "stopped", plus t and duration (s).
    var onState: (([String: Any]) -> Void)?
    /// True while the recorder owns the audio session (don't change it then).
    var isRecording: () -> Bool = { false }

    private var player: AVAudioPlayer?
    private var timer: Timer?
    private var tag: [String: Any] = [:]

    func play(url: URL, at: Double, tag: [String: Any]) throws {
        stop(notify: false)
        if !isRecording() {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playback, mode: .default)
            try s.setActive(true)
        }
        let p = try AVAudioPlayer(contentsOf: url)
        p.delegate = self
        p.prepareToPlay()
        p.currentTime = max(0, min(at, max(0, p.duration - 0.05)))
        p.play()
        player = p
        self.tag = tag
        startTimer()
        emit("playing")
    }

    func pause() { player?.pause(); timer?.invalidate(); emit("paused") }

    func resume() {
        guard let p = player else { return }
        p.play(); startTimer(); emit("playing")
    }

    func seek(to t: Double) {
        guard let p = player else { return }
        p.currentTime = max(0, min(t, max(0, p.duration - 0.05)))
        emit(p.isPlaying ? "playing" : "paused")
    }

    func stop(notify: Bool = true) {
        timer?.invalidate(); timer = nil
        guard let p = player else { return }
        p.stop()
        player = nil
        if notify { emit("stopped") }
        releaseSession()
    }

    func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        timer?.invalidate(); timer = nil
        emit("ended", t: p.duration)
        player = nil
        releaseSession()
    }

    private func releaseSession() {
        if !isRecording() {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    private func startTimer() {
        timer?.invalidate()
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.emit("playing") }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func emit(_ state: String, t: Double? = nil) {
        var o = tag
        o["state"] = state
        o["t"] = t ?? player?.currentTime ?? 0
        o["duration"] = player?.duration ?? 0
        onState?(o)
    }
}
