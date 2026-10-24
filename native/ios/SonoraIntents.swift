// Siri, Spotlight and Shortcuts actions for Sonora.
// Lives in the app target (Apple requires App Shortcuts there); copied into
// the generated Xcode project by scripts/ios-add-intents.mjs.
//
//   "Hey Siri, start sleep in Sonora"   -> opens Sonora and starts recording
//   "Hey Siri, wake up Sonora"          -> opens Sonora and stops it
//
// For any other phrase or language, make a shortcut in the Shortcuts app
// with the "Start sleep" action and name it what you'll say ("Bonne nuit").
//
// The intent leaves the command in UserDefaults and posts a notification;
// the SonoraRecorder plugin hands it to the web app (also after a cold start).

import AppIntents
import Foundation

private func sendToSonora(_ command: String) {
    UserDefaults.standard.set(command, forKey: "sonora.pendingCommand")
    NotificationCenter.default.post(name: Notification.Name("SonoraCommand"), object: nil)
}

@available(iOS 16.0, *)
struct StartSleepIntent: AppIntent {
    static var title: LocalizedStringResource = "Start sleep"
    static var description = IntentDescription("Opens Sonora and starts listening for the night.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        sendToSonora("startSleep")
        return .result()
    }
}

@available(iOS 16.0, *)
struct WakeUpIntent: AppIntent {
    static var title: LocalizedStringResource = "Wake up"
    static var description = IntentDescription("Stops tonight's recording and shows your night.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        sendToSonora("wakeUp")
        return .result()
    }
}

@available(iOS 16.0, *)
struct SonoraShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartSleepIntent(),
            phrases: [
                "Start sleep in \(.applicationName)",
                "Start sleeping with \(.applicationName)",
                "\(.applicationName) start sleep",
                "Good night \(.applicationName)",
            ],
            shortTitle: "Start sleep",
            systemImageName: "moon.zzz.fill"
        )
        AppShortcut(
            intent: WakeUpIntent(),
            phrases: [
                "Wake up \(.applicationName)",
                "Stop \(.applicationName)",
                "\(.applicationName) wake up",
            ],
            shortTitle: "Wake up",
            systemImageName: "sunrise.fill"
        )
    }
}
