import AppKit
import Foundation

// Disposable test application: it contains no user data and never activates
// itself or opens another application. It is terminated by the test runner.
final class Fixture: NSObject, NSApplicationDelegate {
    var panel: NSPanel?
    var count = 0
    var status: NSTextField?
    var titleField: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSPanel(contentRect: NSRect(x: 60, y: 60, width: 360, height: 220),
            styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        window.title = "DSH Computer Use Test"
        let label = NSTextField(labelWithString: "Saved: 0")
        label.frame = NSRect(x: 20, y: 105, width: 220, height: 24)
        let button = NSButton(title: "Save once", target: self, action: #selector(save))
        button.frame = NSRect(x: 20, y: 60, width: 150, height: 30)
        let password = NSSecureTextField(frame: NSRect(x: 20, y: 20, width: 180, height: 24))
        password.stringValue = "fixture-secret-not-user-data"
        let titleInput = NSTextField(frame: NSRect(x: 20, y: 155, width: 240, height: 24))
        titleInput.setAccessibilityTitle("Task title")
        window.contentView?.addSubview(titleInput)
        titleField = titleInput
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(button)
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--rename-trigger" {
            let trigger = CommandLine.arguments[2]
            _ = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
                if FileManager.default.fileExists(atPath: trigger) {
                    button.title = "Changed control"
                    FileHandle.standardOutput.write(Data("RENAMED\n".utf8))
                    timer.invalidate()
                }
            }
        }
        window.contentView?.addSubview(password)
        status = label
        panel = window
        window.orderFrontRegardless()
        FileHandle.standardOutput.write(Data("PID:\(ProcessInfo.processInfo.processIdentifier)\nFRAME:\(window.frame.width),\(window.frame.height)\nLEVEL:\(window.level.rawValue)\nREADY\n".utf8))
    }

    @objc func save() {
        count += 1
        status?.stringValue = "Saved: \(count)"
        if let data = try? JSONSerialization.data(withJSONObject: ["event": "saved", "count": count, "title": titleField?.stringValue ?? ""], options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Fixture()
app.delegate = delegate
app.run()
