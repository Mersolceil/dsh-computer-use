import AppKit
// This window only collects an explicit human decision. It captures no image,
// reads no AX tree, does not grant TCC and never assumes allow on timeout.
final class FloatingApproval: NSObject, NSWindowDelegate {
    var panel: NSPanel!, result: String?, timer: Timer?
    let id: String
    init(_ id: String) { self.id = id; super.init() }
    @objc func allow() { finish("allowed-once") }
    @objc func reject() { finish("rejected") }
    func windowWillClose(_ notification: Notification) { finish("cancelled") }
    func finish(_ outcome: String) {
        guard result == nil else { return }; result = outcome; timer?.invalidate(); panel?.orderOut(nil)
        send(["id": id, "outcome": outcome]); NSApplication.shared.stop(nil)
    }
    static func run(_ request: [String: Any]) {
        guard let id = request["id"] as? String, UUID(uuidString: id) != nil, let reason = request["reason"] as? String, reason.utf8.count <= 20000 else { send(["outcome": "unavailable"]); return }
        do { try VisualInput.requireUnlocked() } catch { send(["id": id, "outcome": "cancelled", "reason": "SESSION_NOT_INTERACTIVE"]); return }
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        let controller = FloatingApproval(id),area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        let panel = NSPanel(contentRect: NSRect(x: area.midX - 260, y: area.midY - 190, width: 520, height: 380), styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
        controller.panel = panel; panel.delegate = controller; panel.title = "DSH · 本次操作授权"; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.level = .modalPanel; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let scroll = NSScrollView(frame: NSRect(x: 16, y: 64, width: 488, height: 300)); scroll.hasVerticalScroller = true
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 470, height: 300)); text.isEditable = false; text.isSelectable = true; text.isRichText = false; text.font = .systemFont(ofSize: 14); text.string = reason; text.isVerticallyResizable = true; text.textContainer?.widthTracksTextView = true; text.autoresizingMask = [.width]; scroll.documentView = text
        let reject = NSButton(title: "拒绝", target: controller, action: #selector(FloatingApproval.reject)); reject.frame = NSRect(x: 260, y: 16, width: 100, height: 32)
        let allow = NSButton(title: "允许这次请求", target: controller, action: #selector(FloatingApproval.allow)); allow.frame = NSRect(x: 365, y: 16, width: 140, height: 32)
        panel.contentView?.addSubview(scroll); panel.contentView?.addSubview(reject); panel.contentView?.addSubview(allow)
        controller.timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in controller.finish("cancelled") }
        DispatchQueue.global().async { while readLine() != nil {} ; DispatchQueue.main.async { controller.finish("cancelled") } }
        panel.orderFrontRegardless(); app.run()
    }
}
