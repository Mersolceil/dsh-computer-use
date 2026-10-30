import ApplicationServices

// Visual input uses Quartz events. No AX element or editable-value APIs,
// no HTML/DOM, no clipboard, and no shell/AppleScript fallback.
final class VisualInput {
    static func sessionState() -> [String: Any] {
        let info = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
        func flag(_ key: String) -> Any { if let value = info[key] as? Bool { return value }; return NSNull() }
        return ["screen_locked": flag("CGSSessionScreenIsLocked"), "login_done": flag(kCGSessionLoginDoneKey as String), "on_console": flag(kCGSessionOnConsoleKey as String)]
    }
    static func requireUnlocked() throws {
        let state = sessionState()
        if state["screen_locked"] as? Bool == true { throw AppFailure.code("SESSION_LOCKED") }
        if state["login_done"] as? Bool == false { throw AppFailure.code("SESSION_NOT_READY") }
        if state["on_console"] as? Bool == false { throw AppFailure.code("SESSION_NOT_ON_CONSOLE") }
    }
    static let keys: [String: (CGKeyCode, CGEventFlags)] = [
        "Enter": (36, []), "Shift+Enter": (36, .maskShift), "Tab": (48, []), "Shift+Tab": (48, .maskShift), "Escape": (53, []),
        "Backspace": (51, []), "Delete": (117, []), "ArrowLeft": (123, []), "ArrowRight": (124, []), "ArrowDown": (125, []), "ArrowUp": (126, []),
        "Home": (115, []), "End": (119, []), "PageUp": (116, []), "PageDown": (121, []),
        "Meta+N": (45, .maskCommand), "Meta+S": (1, .maskCommand), "Meta+A": (0, .maskCommand), "Meta+F": (3, .maskCommand),
        "Meta+W": (13, .maskCommand), "Meta+Z": (6, .maskCommand), "Meta+Shift+Z": (6, [.maskCommand, .maskShift])
    ]
    static func rawWindows() -> [[String: Any]] { (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter { $0[kCGWindowIsOnscreen as String] as? Bool == true } }
    static func frontWindow(_ pid: Int32) -> UInt32 {
        let row = rawWindows().first { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        return row?[kCGWindowNumber as String] as? UInt32 ?? 0
    }
    static func focus(_ app: NSRunningApplication, _ pid: Int32) -> [String: Any] {
        do { try requireUnlocked() } catch AppFailure.code(let code) { return ["ok": false, "error_code": code, "performed": false] } catch { return ["ok": false, "error_code": "SESSION_NOT_READY"] }
        NSApplication.shared.setActivationPolicy(.accessory)
        let unhidden = app.unhide(), activated = app.activate(options: [.activateAllWindows])
        var method = "running-application"
        // macOS may refuse activation from a background helper. LaunchServices
        // can request foregrounding of the same installed/running instance.
        // Never request a new instance, and verify the callback PID.
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid, let url = app.bundleURL {
            let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true; configuration.createsNewApplicationInstance = false; configuration.addsToRecentItems = false
            var completed = false, returnedPid: Int32 = 0
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { running, _ in returnedPid = running?.processIdentifier ?? 0; completed = true }
            let timeout = Date().addingTimeInterval(2)
            while !completed && Date() < timeout { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
            guard completed, returnedPid == pid else { return ["ok": false, "error_code": "FOCUS_TARGET_UNCERTAIN", "state_uncertain": true, "ax_tree_reads_performed": false] }
            method = "launchservices-same-process"
        }
        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid && WindowCapture.windows(pid).contains(where: { $0["on_screen"] as? Bool == true }) { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        let active = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        let visible = WindowCapture.windows(pid).filter { $0["on_screen"] as? Bool == true }
        return ["ok": active, "error_code": active ? NSNull() : "APPLICATION_NOT_FOCUSED", "activated": activated, "activation_method": method, "unhide_requested": unhidden,
                "pid": pid, "frontmost_pid_at_check": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "focus_scope": "instant_at_helper_check_not_a_future_focus_guarantee", "windows": visible, "status": !active ? "focus_failed" : visible.isEmpty ? "needs_window_restore" : "focused",
                "message": visible.isEmpty ? "The app is active but no visible window is confirmed. Use an approved display screenshot and its Window menu to restore the existing window; do not reopen or create a duplicate." : "App activated. Take a fresh screenshot before input.",
                "ax_tree_reads_performed": false]
    }
    static func sameRect(_ a: [String: Any], _ b: [String: Any]) -> Bool {
        ["x", "y", "width", "height"].allSatisfy { key in guard let x = a[key] as? Double, let y = b[key] as? Double else { return false }; return abs(x - y) < 0.5 }
    }
    static func sameSize(_ a: [String: Any], _ b: [String: Any]) -> Bool {
        ["width", "height"].allSatisfy { key in guard let x = a[key] as? Double, let y = b[key] as? Double else { return false }; return abs(x - y) < 0.5 }
    }
    static func checkTarget(_ pid: Int32, _ started: String, _ scope: String, _ window: UInt32, _ front: UInt32, _ rect: [String: Any], forKeyboard: Bool, allowBackground: Bool = false, allowTranslation: Bool = false) throws {
        try requireUnlocked()
        guard ApplicationManager.birth(pid) == started else { throw AppFailure.code("TARGET_CHANGED") }
        guard allowBackground || NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw AppFailure.code("APPLICATION_NOT_FOCUSED") }
        let physical = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        guard physical.isEmpty else { throw AppFailure.code("PHYSICAL_MODIFIER_HELD") }
        if scope == "window" {
            let candidates = WindowCapture.windows(pid)
            guard let current = candidates.first(where: { $0["window_id"] as? UInt32 == window }), let bounds = current["bounds"] as? [String: Any] else {
                throw AppFailure.detail("WINDOW_CHANGED", ["reason": "window_id_unavailable", "expected_window_id": window, "current_window_ids": candidates.compactMap { $0["window_id"] as? UInt32 }])
            }
            let actual: [String: Any] = ["x": bounds["X"]!, "y": bounds["Y"]!, "width": bounds["Width"]!, "height": bounds["Height"]!]
            guard allowTranslation ? sameSize(rect, actual) : sameRect(rect, actual) else {
                throw AppFailure.detail("WINDOW_CHANGED", ["reason": "geometry_changed", "expected_rect": rect, "current_rect": actual, "translation_allowed": allowTranslation])
            }
            if forKeyboard && frontWindow(pid) != window { throw AppFailure.code("WINDOW_NOT_FRONTMOST") }
        } else if scope == "display" {
            if forKeyboard && frontWindow(pid) != front { throw AppFailure.code("WINDOW_CHANGED") }
        } else { throw AppFailure.code("INVALID_VISUAL_CONTEXT") }
    }
    static func key(_ pid: Int32, _ code: CGKeyCode, _ flags: CGEventFlags, text: String? = nil) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw AppFailure.code("INPUT_EVENT_UNAVAILABLE") }
        down.flags = flags; up.flags = flags
        if let text = text {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { pointer in down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress); up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress) }
        }
        down.postToPid(pid); up.postToPid(pid); usleep(4000)
    }
    static func perform(_ request: [String: Any], _ pid: Int32, _ started: String) throws -> [String: Any] {
        let prior = NSWorkspace.shared.frontmostApplication
        let priorBirth = prior.flatMap { ApplicationManager.birth($0.processIdentifier) }
        func returnHost() -> Bool? {
            guard request["restore_host"] as? Bool == true, let app = prior, app.bundleIdentifier == "com.deepseek.dsh", app.processIdentifier != pid,
                  let birth = priorBirth, ApplicationManager.birth(app.processIdentifier) == birth,
                  NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return nil }
            // Give the posted events a bounded chance to reach the target.
            RunLoop.current.run(until: Date().addingTimeInterval(0.04))
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return nil }
            return focus(app, app.processIdentifier)["ok"] as? Bool == true
        }
        do {
            var result = try performInTarget(request, pid, started)
            if let restored = returnHost() { result["host_focus_returned"] = restored }
            return result
        } catch { _ = returnHost(); throw error }
    }
    static func performInTarget(_ request: [String: Any], _ pid: Int32, _ started: String) throws -> [String: Any] {
        NSApplication.shared.setActivationPolicy(.accessory)
        guard AXIsProcessTrusted() else { throw AppFailure.code("INPUT_PERMISSION_REQUIRED") }
        guard let action = request["input_action"] as? String, let visual = request["visual"] as? [String: Any], let args = request["input"] as? [String: Any],
              let scope = visual["scope"] as? String, let window = visual["window_id"] as? UInt32, let front = visual["front_window_id"] as? UInt32,
              let originalRect = visual["rect"] as? [String: Any], let stamp = visual["visual_stamp"] as? String else { throw AppFailure.code("INVALID_VISUAL_CONTEXT") }
        var rect = originalRect
        let keyboard = action == "key" || action == "type"
        // Approval UI may have taken focus since the model's screenshot. Restore
        // and verify in THIS native transaction, then refresh the bound image.
        // A mouse click can itself activate an unobscured target; no blind
        // title-bar click or accessibility raise is used as a fallback.
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid, request["restore_focus"] as? Bool == true,
           let app = NSRunningApplication(processIdentifier: pid) { _ = focus(app, pid) }
        let mouseCanActivate = !keyboard && scope == "window"
        try checkTarget(pid, started, scope, window, front, rect, forKeyboard: keyboard, allowBackground: mouseCanActivate, allowTranslation: scope == "window")
        var captureRequest = request; captureRequest["window_id"] = window; captureRequest["display_id"] = visual["display_id"]; captureRequest["digest_only"] = true
        let fresh = scope == "window" ? try WindowCapture.capture(captureRequest) : try WindowCapture.captureDisplay(captureRequest)
        guard fresh["ok"] as? Bool == true else { return fresh }
        let sameImage = fresh["visual_stamp"] as? String == stamp || WindowCapture.similarSamples(visual["visual_sample"] as? String, fresh["visual_sample"] as? String) || (scope == "window" && WindowCapture.similarSamples(visual["visual_focus_sample"] as? String, fresh["visual_focus_sample"] as? String))
        guard sameImage, let currentRect = fresh["capture_rect"] as? [String: Any], (scope == "window" ? sameSize(rect, currentRect) : sameRect(rect, currentRect)) else { throw AppFailure.code("SCREENSHOT_CHANGED") }
        // Rebase image-relative coordinates after a pure window translation.
        // Size and freshly captured content must match; never rebase a resize.
        rect = currentRect
        try checkTarget(pid, started, scope, window, front, rect, forKeyboard: keyboard, allowBackground: mouseCanActivate)
        var attempted = false, sent = 0
        do {
            if action == "key" {
                guard let name = args["key"] as? String, let entry = keys[name] else { throw AppFailure.code("KEY_NOT_ALLOWED") }
                if scope == "display" && front == 0 && !["Enter", "Escape", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp"].contains(name) { throw AppFailure.code("NO_VISIBLE_TARGET_WINDOW") }
                attempted = true; try key(pid, entry.0, entry.1)
            } else if action == "type" {
                guard let text = args["text"] as? String, !text.isEmpty, text.utf16.count <= 10000 else { throw AppFailure.code("INVALID_TEXT") }
                guard scope == "window" || front != 0 else { throw AppFailure.code("NO_VISIBLE_TARGET_WINDOW") }
                var chunks: [String] = [], buffer = ""
                for character in text.replacingOccurrences(of: "\r\n", with: "\n") {
                    let value = String(character)
                    guard value.utf16.count <= 16 else { throw AppFailure.code("TEXT_CLUSTER_TOO_LONG") }
                    if value == "\n" { if !buffer.isEmpty { chunks.append(buffer); buffer = "" }; chunks.append("\n") }
                    else { if (buffer + value).utf16.count > 16 { chunks.append(buffer); buffer = "" }; buffer += value }
                }
                if !buffer.isEmpty { chunks.append(buffer) }
                guard chunks.count <= 1000 else { throw AppFailure.code("TOO_MANY_INPUT_EVENTS") }
                for chunk in chunks {
                    try checkTarget(pid, started, scope, window, front, rect, forKeyboard: true)
                    attempted = true
                    if chunk == "\n" { try key(pid, 36, []) } else { try key(pid, 0, [], text: chunk) }
                    sent += chunk.utf16.count
                }
            } else if action == "pixel_click" || action == "scroll" {
                guard let x = args["x"] as? Double, let y = args["y"] as? Double, let width = visual["image_width"] as? Double, let height = visual["image_height"] as? Double,
                      [x,y,width,height].allSatisfy({ $0.isFinite }), x >= 0, y >= 0, x < width, y < height, width > 0, height > 0,
                      let rx = rect["x"] as? Double, let ry = rect["y"] as? Double, let rw = rect["width"] as? Double, let rh = rect["height"] as? Double else { throw AppFailure.code("INVALID_COORDINATE") }
                let point = CGPoint(x: rx + x * rw / width, y: ry + y * rh / height)
                guard WindowCapture.displays().contains(where: { row in guard let r = row["rect"] as? [String: Double] else { return false }; return CGRect(x: r["x"]!, y: r["y"]!, width: r["width"]!, height: r["height"]!).contains(point) }) else { throw AppFailure.code("POINT_OUTSIDE_DISPLAYS") }
                // Public AppKit hit testing honors ignoresMouseEvents, unlike
                // the first overlapping CG rectangle (e.g. Dock tracking UI).
                let cocoaPoint = NSPoint(x: point.x, y: CGDisplayBounds(CGMainDisplayID()).height - point.y)
                let hitNumber = NSWindow.windowNumber(at: cocoaPoint, belowWindowWithWindowNumber: 0)
                let hit = rawWindows().first { $0[kCGWindowNumber as String] as? Int == hitNumber }
                let ownsPoint = hit?[kCGWindowOwnerPID as String] as? Int32 == pid && (scope == "display" || hit?[kCGWindowNumber as String] as? UInt32 == window)
                // Only the app-menu area, excluding Apple menu and system
                // status icons, may route through a system-owned menu surface.
                let menuBar = scope == "display" && hit?[kCGWindowLayer as String] as? Int == Int(CGWindowLevelForKey(.mainMenuWindow)) && point.y >= ry && point.y < ry + 40 && point.x >= rx + 40 && point.x < rx + min(600, rw * 0.65) && visual["display_id"] as? UInt32 == CGMainDisplayID()
                guard ownsPoint || menuBar else { return ["ok": false, "error_code": "POINT_OBSCURED_OR_FOREIGN", "state_uncertain": false, "hit_pid": hit?[kCGWindowOwnerPID as String] ?? 0, "hit_window_id": hit?[kCGWindowNumber as String] ?? 0, "expected_window_id": window, "ax_tree_reads_performed": false] }
                attempted = true
                if action == "scroll" {
                    guard let dy = args["dy"] as? Int32, abs(Int64(dy)) <= 500 else { throw AppFailure.code("INVALID_SCROLL") }
                    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left), let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0) else { throw AppFailure.code("INPUT_EVENT_UNAVAILABLE") }
                    event.location = point
                    try checkTarget(pid, started, scope, window, front, rect, forKeyboard: false, allowBackground: mouseCanActivate)
                    move.post(tap: .cghidEventTap); event.post(tap: .cghidEventTap)
                } else {
                    let right = args["button"] as? String == "right", button: CGMouseButton = right ? .right : .left
                    guard let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: button), let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: button) else { throw AppFailure.code("INPUT_EVENT_UNAVAILABLE") }
                    down.flags = []; up.flags = []; down.setIntegerValueField(.mouseEventClickState, value: 1); up.setIntegerValueField(.mouseEventClickState, value: 1)
                    try checkTarget(pid, started, scope, window, front, rect, forKeyboard: false, allowBackground: mouseCanActivate)
                    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
                }
            } else { throw AppFailure.code("INVALID_INPUT_ACTION") }
            return ["ok": true, "action": action, "verification_scope": "event_delivery_only", "state_uncertain": true, "requires_fresh_screenshot": true,
                    "utf16_units_sent": sent, "ax_tree_reads_performed": false, "html_reads_performed": false, "clipboard_used": false]
        } catch AppFailure.detail(let code, let details) {
            return ["ok": false, "error_code": code, "diagnostics": details, "state_uncertain": attempted, "utf16_units_sent": sent, "requires_fresh_screenshot": true]
        } catch AppFailure.code(let code) {
            return ["ok": false, "error_code": code, "state_uncertain": attempted, "utf16_units_sent": sent, "requires_fresh_screenshot": true, "ax_tree_reads_performed": false, "clipboard_used": false]
        }
    }
}
