import AppKit
import Foundation

// Disposable editor for input-event verification. Its own state is saved only
// to the test runner's temporary path; no personal app, vault, AX or HTML.
final class VisualTextView: NSTextView {
    var clicks = 0
    override func mouseDown(with event: NSEvent) { clicks += 1; super.mouseDown(with: event) }
}
final class VisualFixtureWindow: NSWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        // Deliberately preserve the off-display geometry in the regression
        // fixture; AppKit otherwise moves a newly shown window back on-screen.
        if ProcessInfo.processInfo.environment["DSH_FIXTURE_PARTLY_OFFSCREEN"] == "1" { return frameRect }
        return super.constrainFrameRect(frameRect, to: screen)
    }
}
final class VisualFixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var editor: VisualTextView!
    var status: NSTextField!
    var created = 0, saved = 0
    func applicationDidFinishLaunching(_ note: Notification) {
        let menu = NSMenu(), item = NSMenuItem(), applicationMenu = NSMenu(title: "Visual Fixture")
        let new = NSMenuItem(title: "New Note", action: #selector(newNote), keyEquivalent: "n"); new.target = self
        let save = NSMenuItem(title: "Save Note", action: #selector(saveNote), keyEquivalent: "s"); save.target = self
        let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationMenu.addItem(new); applicationMenu.addItem(save); applicationMenu.addItem(quit); item.submenu = applicationMenu; menu.addItem(item)
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: ""), windowMenu = NSMenu(title: "Window")
        let restore = NSMenuItem(title: "Restore Test Note", action: #selector(restoreWindow), keyEquivalent: ""); restore.target = self; windowMenu.addItem(restore); windowItem.submenu = windowMenu; menu.addItem(windowItem)
        NSApplication.shared.mainMenu = menu; NSApplication.shared.windowsMenu = windowMenu
        window = VisualFixtureWindow(contentRect: NSRect(x: 100, y: 100, width: 420, height: 340), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        if ProcessInfo.processInfo.environment["DSH_FIXTURE_PARTLY_OFFSCREEN"] == "1", let screen = NSScreen.main {
            window.setFrameOrigin(NSPoint(x: screen.frame.maxX - 210, y: 100))
        }
        window.title = "DSH Visual-only Fixture"
        window.collectionBehavior = [.moveToActiveSpace]
        status = NSTextField(labelWithString: "New: 0   Saved: 0"); status.frame = NSRect(x: 20, y: 302, width: 380, height: 24)
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 20, width: 380, height: 265)); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        editor = VisualTextView(frame: NSRect(x: 0, y: 0, width: 360, height: 265)); editor.isRichText = false; editor.font = .systemFont(ofSize: 16); editor.isVerticallyResizable = true; editor.autoresizingMask = [.width]; editor.textContainer?.widthTracksTextView = true
        scroll.documentView = editor; window.contentView?.addSubview(scroll); window.contentView?.addSubview(status); window.makeKeyAndOrderFront(nil); window.orderFrontRegardless(); window.makeFirstResponder(editor)
        FileHandle.standardOutput.write(Data("PID:\(ProcessInfo.processInfo.processIdentifier)\nFRAME:\(window.frame.width),\(window.frame.height)\nREADY\n".utf8))
    }
    @objc func newNote() { created += 1; editor.string = ""; window.makeFirstResponder(editor); update() }
    @objc func restoreWindow() { window.deminiaturize(nil); window.makeKeyAndOrderFront(nil); window.makeFirstResponder(editor) }
    @objc func saveNote() {
        saved += 1; update()
        if let path = Bundle.main.object(forInfoDictionaryKey: "DSHFixtureOutput") as? String,
           let data = try? JSONSerialization.data(withJSONObject: ["new_count": created, "save_count": saved, "clicks": editor.clicks, "text": editor.string]) { try? data.write(to: URL(fileURLWithPath: path), options: .atomic) }
    }
    func update() { status.stringValue = "New: \(created)   Saved: \(saved)" }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = VisualFixture()
app.delegate = delegate
app.run()
