import AVFoundation
import Foundation
import SoundAnalysis

/// Names a sound ("speech", "cough", "dog bark", ...) with Apple's built-in
/// on-device classifier (SoundAnalysis, iOS 15+, ~300 sound types). Nothing
/// is downloaded or bundled, and nothing leaves the phone.
final class SoundLabeler {
    /// Labels below this confidence are dropped rather than guessed.
    static let minConfidence = 0.5
    private static let ignored: Set<String> = ["silence", "noise"]

    private let request: SNClassifySoundRequest?

    init() {
        request = try? SNClassifySoundRequest(classifierIdentifier: .version1)
    }

    /// Best label for a clip of 16 kHz mono samples, or nil.
    func label(_ samples: [Float], sampleRate: Double = 16_000) -> String? {
        guard let request,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
                                         channels: 1, interleaved: false) else { return nil }
        // The classifier looks at windows of about a second and a half; pad short clips.
        let count = max(samples.count, Int(sampleRate * 3))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let channel = buffer.floatChannelData?[0] else { return nil }
        buffer.frameLength = AVAudioFrameCount(count)
        for i in 0..<count { channel[i] = i < samples.count ? samples[i] : 0 }

        let analyzer = SNAudioStreamAnalyzer(format: format)
        let observer = BestResult()
        do { try analyzer.add(request, withObserver: observer) } catch { return nil }
        analyzer.analyze(buffer, atAudioFramePosition: 0)
        analyzer.completeAnalysis()      // returns once every window has been classified

        guard let best = observer.best, best.confidence >= Self.minConfidence,
              !Self.ignored.contains(best.identifier) else { return nil }
        return best.identifier.replacingOccurrences(of: "_", with: " ")
    }
}

private final class BestResult: NSObject, SNResultsObserving {
    private let lock = NSLock()
    private var top: (identifier: String, confidence: Double)?

    var best: (identifier: String, confidence: Double)? {
        lock.lock(); defer { lock.unlock() }
        return top
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult,
              let first = result.classifications.first else { return }
        lock.lock(); defer { lock.unlock() }
        if top == nil || first.confidence > top!.confidence {
            top = (first.identifier, first.confidence)
        }
    }
}
