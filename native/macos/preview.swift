import AppKit

final class TrackingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
final class WindowPreview: NSObject, NSWindowDelegate {
    var panel: TrackingPanel!, picture: NSImageView!, label: NSTextField!, timer: Timer?
    var request: [String: Any], frames = 0, busy = false, stopped = false
    let deadline: Date, parent = getppid()
    init(_ request: [String: Any]) {
        self.request = request
        deadline = Date().addingTimeInterval(Double(request["duration_seconds"] as? Int ?? 300))
        super.init()
    }
    func start() {
        NSApplication.shared.setActivationPolicy(.accessory)
        let area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
        let width = 330.0, height = 292.0
        let candidates = [NSRect(x: area.minX + 15, y: area.minY + 15, width: width, height: height), NSRect(x: area.maxX - width - 15, y: area.minY + 15, width: width, height: height), NSRect(x: area.minX + 15, y: area.maxY - height - 15, width: width, height: height), NSRect(x: area.maxX - width - 15, y: area.maxY - height - 15, width: width, height: height)]
        var targetFrame = NSRect.zero
        if let pid = request["pid"] as? Int32, let id = request["window_id"] as? UInt32, let bounds = WindowCapture.windows(pid).first(where: { $0["window_id"] as? UInt32 == id })?["bounds"] as? [String: Any], let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double, let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double {
            targetFrame = NSRect(x: x, y: CGDisplayBounds(CGMainDisplayID()).height - y - h, width: w, height: h)
        }
        func overlap(_ frame: NSRect) -> Double { let intersection = frame.intersection(targetFrame); return intersection.isNull ? 0 : intersection.width * intersection.height }
        let position = candidates.min { overlap($0) < overlap($1) } ?? candidates[0]
        panel = TrackingPanel(contentRect: NSRect(x: position.minX, y: position.minY, width: 330, height: 260), styleMask: [.titled, .closable, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
        panel.title = "CU · 指定窗口预览"; panel.delegate = self; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.level = .floating; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; panel.minSize = NSSize(width: 270, height: 210)
        label = NSTextField(labelWithString: "准备预览 · 关闭即撤销本次任务授权")
        label.frame = NSRect(x: 10, y: 231, width: 310, height: 20); label.autoresizingMask = [.width, .minYMargin]
        picture = NSImageView(frame: NSRect(x: 10, y: 45, width: 310, height: 180)); picture.imageScaling = .scaleProportionallyUpOrDown; picture.autoresizingMask = [.width, .height]
        let focus = NSButton(title: "切到目标", target: self, action: #selector(activateTarget)); focus.frame = NSRect(x: 10, y: 10, width: 100, height: 28)
        let stop = NSButton(title: "停止并撤销", target: self, action: #selector(stopByUser)); stop.frame = NSRect(x: 115, y: 10, width: 120, height: 28)
        for view in [picture!, label!, focus, stop] as [NSView] { panel.contentView?.addSubview(view) }
        panel.orderFrontRegardless()
        send(["ok": true, "ready": true, "preview_window_id": panel.windowNumber, "nonactivating": true, "interval_seconds": 2, "model_image_delivery": false])
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }
    func validate() throws -> Int32 {
        _ = try ApplicationManager.approvedApplication(request)
        guard let pid = request["pid"] as? Int32, let bundle = request["bundle_id"] as? String,
              let started = request["process_start"] as? String else { throw AppFailure.code("INVALID_REQUEST") }
        let (_, target) = try ApplicationManager.running(pid, bundle)
        guard target["process_start"] as? String == started else { throw AppFailure.code("TARGET_CHANGED") }
        return pid
    }
    func refresh() {
        guard !busy, !stopped else { return }; busy = true; defer { busy = false }
        guard Date() < deadline, getppid() == parent else { finish("EXPIRED_OR_PARENT_CLOSED"); return }
        do {
            _ = try validate(); var capture = request; capture["preview_only"] = true
            let result = try WindowCapture.capture(capture)
            guard result["ok"] as? Bool == true, let screenshot = result["screenshot"] as? [String: Any], let encoded = screenshot["data"] as? String,
                  let data = Data(base64Encoded: encoded), let image = NSImage(data: data) else { finish(result["error_code"] as? String ?? "PREVIEW_CAPTURE_FAILED"); return }
            guard !stopped else { return }; picture.image = image; frames += 1
            label.stringValue = "窗口\(request["window_id"] ?? 0) · 已更新\(frames)次 · 本地预览"
            send(["ok": true, "event": "frame", "frames": frames, "preview_window_id": panel.windowNumber])
        } catch AppFailure.code(let code) { finish(code) } catch { finish("PREVIEW_FAILED") }
    }
    @objc func activateTarget() {
        do { let pid = try validate(); if let app = NSRunningApplication(processIdentifier: pid) { let result = VisualInput.focus(app, pid); if result["ok"] as? Bool != true { label.stringValue = "未取得焦点；请手动切到目标。预览仍可读取。" } } } catch { finish("TARGET_CHANGED") }
    }
    @objc func stopByUser() { finish("USER_REVOKED") }
    func windowWillClose(_ notification: Notification) { finish("USER_REVOKED") }
    func finish(_ reason: String) {
        guard !stopped else { return }; stopped = true; timer?.invalidate(); picture?.image = nil; panel?.orderOut(nil)
        send(["ok": true, "event": "stopped", "reason": reason]); NSApplication.shared.stop(nil)
    }
    static func run(_ request: [String: Any]) {
        guard let duration = request["duration_seconds"] as? Int, duration >= 10, duration <= 900 else { send(["ok": false, "error_code": "INVALID_DURATION"]); return }
        let preview = WindowPreview(request)
        do { _ = try preview.validate(); try VisualInput.requireUnlocked() } catch { send(["ok": false, "error_code": "PREVIEW_TARGET_UNAVAILABLE"]); return }
        let app = NSApplication.shared
        DispatchQueue.global().async { while readLine() != nil {} ; DispatchQueue.main.async { preview.finish("PARENT_CLOSED") } }
        preview.start(); if !preview.stopped { app.run() }
    }
}
