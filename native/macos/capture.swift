import ScreenCaptureKit
import ImageIO
import CryptoKit

// Window capture is independent of focus and display clipping. Display capture
// remains an explicit separate scope; neither path reads AX or HTML.
final class WindowCapture {
    static func visualSample(_ image: CGImage) -> Data {
        var pixels = [UInt8](repeating: 0, count: 16 * 16 * 4)
        pixels.withUnsafeMutableBytes { storage in
            if let context = CGContext(data: storage.baseAddress, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                context.interpolationQuality = .low; context.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
            }
        }
        return Data(pixels.map { $0 / 16 })
    }
    static func similarSamples(_ first: String?, _ second: String?) -> Bool {
        guard let first = first, let second = second, let a = Data(base64Encoded: first), let b = Data(base64Encoded: second), a.count == 1024, b.count == 1024 else { return false }
        var changed = 0
        for offset in stride(from: 0, to: 1024, by: 4) {
            let delta = (0..<3).map { abs(Int(a[offset + $0]) - Int(b[offset + $0])) }.max() ?? 0
            if delta > 1 { return false }
            if delta > 0 { changed += 1 }
        }
        return changed <= 2 // Small caret/hover changes, not a pixel-perfect guarantee.
    }
    static func displays() -> [[String: Any]] {
        NSApplication.shared.setActivationPolicy(.accessory)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 32 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { id in let rect = CGDisplayBounds(id); return ["display_id": id, "main": id == CGMainDisplayID(), "rect": ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]] }
    }
    static func encode(_ image: CGImage, _ metadata: [String: Any], digestOnly: Bool) throws -> [String: Any] {
        guard hasVisibleContent(image) else { return ["ok": false, "error_code": "SCREENSHOT_EMPTY_OR_PROTECTED", "message": "The captured image is black/transparent; no image was delivered. Check the selected window/display and permission, not just lock state."] }
        let sample = visualSample(image)
        var result = metadata; result["ok"] = true; result["screenshot_id"] = UUID().uuidString; result["visual_stamp"] = SHA256.hash(data: sample).map { String(format: "%02x", $0) }.joined(); result["visual_sample"] = sample.base64EncodedString()
        // Activation repaints the native title bar. Also retain a coarse
        // content-only sample so a real focus handoff does not deadlock input.
        if metadata["capture_source"] as? String == "macos-window", let rect = metadata["capture_rect"] as? [String: Any], let logicalHeight = rect["height"] as? Double {
            let inset = min(image.height / 4, Int(32 * Double(image.height) / logicalHeight))
            if inset > 0, let content = image.cropping(to: CGRect(x: 0, y: inset, width: image.width, height: image.height - inset)) {
                result["visual_focus_sample"] = visualSample(content).base64EncodedString()
            }
        }
        if digestOnly { return result }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw AppFailure.code("SCREENSHOT_FAILED") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination), data.length <= 4 * 1024 * 1024 else { throw AppFailure.code("SCREENSHOT_TOO_LARGE") }
        result["screenshot"] = ["mimeType": "image/png", "data": (data as Data).base64EncodedString(), "width": image.width, "height": image.height]
        return result
    }
    static func hasVisibleContent(_ image: CGImage) -> Bool {
        var pixels = [UInt8](repeating: 0, count: 16 * 16 * 4)
        return pixels.withUnsafeMutableBytes { storage in
            guard let context = CGContext(data: storage.baseAddress, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
            let bytes = storage.bindMemory(to: UInt8.self)
            return stride(from: 0, to: bytes.count, by: 4).contains { max(bytes[$0], bytes[$0 + 1], bytes[$0 + 2]) > 3 }
        }
    }
    static func windows(_ pid: Int32) -> [[String: Any]] {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let owner = row[kCGWindowOwnerPID as String] as? Int32, owner == pid,
                  let id = row[kCGWindowNumber as String] as? UInt32,
                  let layer = row[kCGWindowLayer as String] as? Int, layer >= 0, layer <= Int(CGWindowLevelForKey(.modalPanelWindow)),
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double,
                  width > 1, height > 1 else { return nil }
            let rect = CGRect(x: bounds["X"] as? Double ?? 0, y: bounds["Y"] as? Double ?? 0, width: width, height: height)
            let screens = displays().compactMap { $0["rect"] as? [String: Double] }.map { CGRect(x: $0["x"]!, y: $0["y"]!, width: $0["width"]!, height: $0["height"]!) }
            let intersects = screens.contains { !$0.intersection(rect).isEmpty }
            let contained = screens.contains { $0.contains(rect) }
            return ["window_id": id, "layer": layer, "bounds": bounds, "on_screen": row[kCGWindowIsOnscreen as String] as? Bool ?? false,
                    "display_geometry": contained ? "within_one_display" : intersects ? "partly_outside_or_spanning_displays" : "outside_displays",
                    "capture_policy": "try_selected_window_independently_of_focus_and_display_clipping"]
        }.sorted { left, right in
            let visibleLeft = left["on_screen"] as? Bool ?? false, visibleRight = right["on_screen"] as? Bool ?? false
            if visibleLeft != visibleRight { return visibleLeft }
            return (left["window_id"] as? UInt32 ?? 0) > (right["window_id"] as? UInt32 ?? 0)
        }.prefix(40).map { $0 }
    }
    static func waitFor<T>(_ work: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
        var result: Result<T, Error>?
        let lock = NSLock()
        func current() -> Result<T, Error>? { lock.lock(); defer { lock.unlock() }; return result }
        work { value in lock.lock(); result = value; lock.unlock() }
        let deadline = Date().addingTimeInterval(5)
        while current() == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        guard let value = current() else { throw AppFailure.code("SCREENSHOT_TIMEOUT") }
        return try value.get()
    }
    static func capture(_ request: [String: Any]) throws -> [String: Any] {
        try VisualInput.requireUnlocked()
        guard CGPreflightScreenCaptureAccess() else {
            return ["ok": false, "error_code": "SCREEN_RECORDING_PERMISSION_REQUIRED", "helper": Bundle.main.bundlePath,
                    "message": "Enable Screen Recording for the responsible helper/DSH application shown by macOS, then restart it when idle. Permission may differ between a terminal and DSH. No screenshot was taken."]
        }
        guard #available(macOS 14.0, *) else { throw AppFailure.code("SCREENSHOT_REQUIRES_MACOS_14") }
        // AppKit must establish this command-line helper's WindowServer
        // connection before SCContentFilter queries display geometry.
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        guard !NSScreen.screens.isEmpty else { throw AppFailure.code("DISPLAY_UNAVAILABLE") }
        guard let pid = request["pid"] as? Int32, let bundle = request["bundle_id"] as? String,
              let started = request["process_start"] as? String, let id = request["window_id"] as? UInt32 else { throw AppFailure.code("INVALID_REQUEST") }
        guard windows(pid).contains(where: { $0["window_id"] as? UInt32 == id }) else { throw AppFailure.code("UNKNOWN_WINDOW") }
        let content: SCShareableContent = try waitFor { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { value, error in
                if let value = value { done(.success(value)) } else { done(.failure(error ?? AppFailure.code("WINDOWS_UNAVAILABLE"))) }
            }
        }
        guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == pid && $0.owningApplication?.bundleIdentifier == bundle }),
              ApplicationManager.birth(pid) == started else { throw AppFailure.code("WINDOW_TARGET_CHANGED") }
        guard !content.displays.isEmpty, !window.frame.isNull, !window.frame.isInfinite,
              [window.frame.origin.x, window.frame.origin.y, window.frame.width, window.frame.height].allSatisfy({ $0.isFinite }),
              window.frame.width > 1 && window.frame.height > 1 else { throw AppFailure.code("WINDOW_NOT_CAPTURABLE") }
        let requestedDimension = request["max_dimension"] as? Double ?? 1024.0
        guard requestedDimension >= 640, requestedDimension <= 1600 else { throw AppFailure.code("INVALID_IMAGE_DIMENSION") }
        let maxDimension = request["preview_only"] as? Bool == true ? 640.0 : requestedDimension
        let scale = min(1.0, maxDimension / max(window.frame.width, window.frame.height)), config = SCStreamConfiguration()
        config.width = max(1, Int(window.frame.width * scale)); config.height = max(1, Int(window.frame.height * scale)); config.showsCursor = false; config.ignoreShadowsSingleWindow = true
        let image: CGImage = try waitFor { done in
            SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config) { value, error in
                if let value = value { done(.success(value)) } else { done(.failure(error ?? AppFailure.code("SCREENSHOT_FAILED"))) }
            }
        }
        guard ApplicationManager.birth(pid) == started, windows(pid).contains(where: { $0["window_id"] as? UInt32 == id }) else { throw AppFailure.code("WINDOW_TARGET_CHANGED") }
        guard hasVisibleContent(image) else {
            return ["ok": false, "error_code": "SCREENSHOT_EMPTY_OR_PROTECTED", "window_id": id, "width": image.width, "height": image.height,
                    "expected_width": config.width, "expected_height": config.height,
                    "message": "macOS returned a black/transparent image. Unlock the desktop and check capture permission/protected content; no image was delivered. An intentionally all-black window also triggers this conservative check. Do not retry in a loop."]
        }
        guard let current = windows(pid).first(where: { $0["window_id"] as? UInt32 == id }), let bounds = current["bounds"] as? [String: Any] else { throw AppFailure.code("WINDOW_TARGET_CHANGED") }
        return try encode(image, ["pid": pid, "bundle_id": bundle, "window_id": id, "capture_source": "macos-window", "screen_scope": "selected_application_window",
                "capture_rect": ["x": bounds["X"]!, "y": bounds["Y"]!, "width": bounds["Width"]!, "height": bounds["Height"]!], "front_window_id": VisualInput.frontWindow(pid), "display_geometry": current["display_geometry"] ?? "unknown", "on_screen": current["on_screen"] ?? false,
                "coordinate_space": "image pixels; origin at top-left; visual inputs require approval and a fresh bound screenshot",
                "message": "Actual OS window capture. An occluded surface is not proof that mouse input can reach it."], digestOnly: request["digest_only"] as? Bool == true)
    }
    static func captureDisplay(_ request: [String: Any]) throws -> [String: Any] {
        try VisualInput.requireUnlocked()
        guard CGPreflightScreenCaptureAccess() else { throw AppFailure.code("SCREEN_RECORDING_PERMISSION_REQUIRED") }
        guard #available(macOS 14.0, *) else { throw AppFailure.code("SCREENSHOT_REQUIRES_MACOS_14") }
        NSApplication.shared.setActivationPolicy(.accessory)
        guard let id = request["display_id"] as? UInt32, let pid = request["pid"] as? Int32,
              let started = request["process_start"] as? String else { throw AppFailure.code("INVALID_REQUEST") }
        let content: SCShareableContent = try waitFor { done in SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { value, error in if let value = value { done(.success(value)) } else { done(.failure(error ?? AppFailure.code("DISPLAY_UNAVAILABLE"))) } } }
        guard let display = content.displays.first(where: { $0.displayID == id }) else { throw AppFailure.code("UNKNOWN_DISPLAY") }
        let rect = CGDisplayBounds(id), scale = min(1.0, 1600.0 / max(rect.width, rect.height)), config = SCStreamConfiguration()
        guard !rect.isNull, !rect.isInfinite, rect.width > 1, rect.height > 1 else { throw AppFailure.code("DISPLAY_UNAVAILABLE") }
        config.width = max(1, Int(rect.width * scale)); config.height = max(1, Int(rect.height * scale)); config.showsCursor = false
        let image: CGImage = try waitFor { done in SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config) { value, error in if let value = value { done(.success(value)) } else { done(.failure(error ?? AppFailure.code("SCREENSHOT_FAILED"))) } } }
        guard ApplicationManager.birth(pid) == started else { throw AppFailure.code("TARGET_CHANGED") }
        return try encode(image, ["pid": pid, "display_id": id, "capture_source": "macos-display", "screen_scope": "entire_selected_display", "front_window_id": VisualInput.frontWindow(pid),
                                  "capture_rect": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]], digestOnly: request["digest_only"] as? Bool == true)
    }
}
