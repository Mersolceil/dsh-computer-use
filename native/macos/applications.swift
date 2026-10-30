import AppKit
import Darwin
import Foundation

// Application lifecycle only. LaunchServices handles installed .app bundles;
// no shell strings, document opening, force-quit or Gatekeeper bypass.
enum AppFailure: Error { case code(String); case detail(String, [String: Any]) }
final class ApplicationManager {
    static func birth(_ pid: pid_t) -> String? {
        var info = proc_bsdinfo(); let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        let count = withUnsafeMutablePointer(to: &info) { proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, size) }
        return count == size && info.pbi_start_tvsec > 0 ? "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)" : nil
    }
    static func describe(_ url: URL) throws -> [String: Any] {
        let path = url.standardizedFileURL.resolvingSymlinksInPath()
        guard path.pathExtension == "app", let bundle = Bundle(url: path),
              let id = bundle.bundleIdentifier, let executable = bundle.executableURL else { throw AppFailure.code("INVALID_APPLICATION") }
        let attrs = try FileManager.default.attributesOfItem(atPath: executable.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular,
              let inode = attrs[.systemFileNumber], let device = attrs[.systemNumber],
              let size = attrs[.size], let modified = attrs[.modificationDate] as? Date else { throw AppFailure.code("INVALID_APPLICATION") }
        let roots = ["/Applications/", "/System/Applications/", FileManager.default.homeDirectoryForCurrentUser.path + "/Applications/"]
        return ["path": path.path, "bundle_id": id,
                "name": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? path.deletingPathExtension().lastPathComponent,
                "fingerprint": "\(path.path)|\(id)|\(device)|\(inode)|\(size)|\(modified.timeIntervalSince1970)",
                "trusted_location": roots.contains(where: { path.path.hasPrefix($0) })]
    }
    static func resolve(_ name: String) throws -> [String: Any] {
        if name.hasPrefix("/") { return try describe(URL(fileURLWithPath: name)) }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return try describe(url) }
        if let path = NSWorkspace.shared.fullPath(forApplication: name) { return try describe(URL(fileURLWithPath: path)) }
        let roots = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", FileManager.default.homeDirectoryForCurrentUser.path + "/Applications"]
        var matches: [String: [String: Any]] = [:]
        for root in roots {
            for child in (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? [] {
                guard child.hasSuffix(".app"), child.localizedCaseInsensitiveContains(name),
                      let found = try? describe(URL(fileURLWithPath: root).appendingPathComponent(child)), let path = found["path"] as? String else { continue }
                matches[path] = found
            }
        }
        guard matches.count == 1, let result = matches.values.first else { throw AppFailure.code(matches.isEmpty ? "APPLICATION_NOT_FOUND" : "APPLICATION_NAME_AMBIGUOUS") }
        return result
    }
    static func running(_ pid: Int32, _ bundle: String) throws -> (NSRunningApplication, [String: Any]) {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.bundleIdentifier == bundle, let url = app.bundleURL, let started = birth(pid) else { throw AppFailure.code("TARGET_IDENTITY_MISMATCH") }
        var data = try describe(url); data["pid"] = pid; data["process_start"] = started
        return (app, data)
    }
    static func approvedApplication(_ request: [String: Any]) throws -> [String: Any] {
        guard let path = request["path"] as? String, let expected = request["fingerprint"] as? String,
              let bundle = request["bundle_id"] as? String else { throw AppFailure.code("INVALID_REQUEST") }
        let actual = try describe(URL(fileURLWithPath: path))
        guard actual["fingerprint"] as? String == expected, actual["bundle_id"] as? String == bundle else { throw AppFailure.code("APPLICATION_CHANGED") }
        return actual
    }
    static func handle(_ request: [String: Any]) -> [String: Any] {
        do {
            switch request["action"] as? String {
            case "status":
                return ["ok": true, "protocol": "dsh-desktop/2", "helper_version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
                        "helper": Bundle.main.bundlePath, "accessibility_input": AXIsProcessTrusted(), "screen_recording": CGPreflightScreenCaptureAccess(),
                        "frontmost_pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, "displays": WindowCapture.displays(), "session": VisualInput.sessionState(),
                        "features": ["floating_approval", "return_host_focus", "atomic_focus_input", "local_window_preview", "independent_window_capture", "semantic", "window_screenshot", "display_screenshot", "focus", "pixel_click", "key", "type", "scroll"], "permission_scope": "executing_helper_context_only"]
            case "resolve":
                guard let name = request["application"] as? String, !name.isEmpty, name.utf8.count <= 4096 else { throw AppFailure.code("INVALID_REQUEST") }
                return ["ok": true, "application": try resolve(name)]
            case "inspect":
                guard let pid = request["pid"] as? Int32, pid > 0, let bundle = request["bundle_id"] as? String else { throw AppFailure.code("INVALID_REQUEST") }
                return ["ok": true, "application": try running(pid, bundle).1]
            case "windows", "screenshot", "display_screenshot", "focus", "visual_input":
                _ = try approvedApplication(request)
                guard let pid = request["pid"] as? Int32, let bundle = request["bundle_id"] as? String,
                      let expected = request["process_start"] as? String else { throw AppFailure.code("INVALID_REQUEST") }
                let (app, target) = try running(pid, bundle)
                guard target["process_start"] as? String == expected, target["path"] as? String == request["path"] as? String else { throw AppFailure.code("TARGET_CHANGED") }
                if request["action"] as? String == "windows" { return ["ok": true, "pid": pid, "bundle_id": bundle, "windows": WindowCapture.windows(pid), "capture_source": "macos-window-metadata"] }
                if request["action"] as? String == "focus" { return VisualInput.focus(app, pid) }
                if request["action"] as? String == "visual_input" { return try VisualInput.perform(request, pid, expected) }
                if request["action"] as? String == "display_screenshot" { return try WindowCapture.captureDisplay(request) }
                return try WindowCapture.capture(request)
            case "open":
                let data = try approvedApplication(request)
                let path = data["path"] as! String, bundle = data["bundle_id"] as! String
                let activate = request["activate"] as? Bool ?? false
                let runningApps = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
                let existing = runningApps.filter { $0.bundleURL?.resolvingSymlinksInPath().path == path }
                if existing.isEmpty && !runningApps.isEmpty {
                    return ["ok": false, "error_code": "APPLICATION_ALREADY_RUNNING_AT_OTHER_PATH", "pids": runningApps.map { $0.processIdentifier },
                            "message": "This application is already running from another location. Attach to its existing PID; do not open a duplicate."]
                }
                if existing.count > 1 { return ["ok": false, "error_code": "MULTIPLE_APPLICATION_INSTANCES", "pids": existing.map { $0.processIdentifier }] }
                if let app = existing.first {
                    let activated = activate ? app.activate(options: []) : false
                    return ["ok": true, "status": "already_running", "application": try running(app.processIdentifier, bundle).1, "activated": activated]
                }
                let config = NSWorkspace.OpenConfiguration()
                config.activates = activate; config.createsNewApplicationInstance = false; config.addsToRecentItems = false
                var completed = false, launched: NSRunningApplication?, launchError: Error?
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: path), configuration: config) { app, error in
                    launched = app; launchError = error; completed = true
                }
                let deadline = Date().addingTimeInterval(10)
                while !completed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
                guard completed else { return ["ok": false, "error_code": "APPLICATION_LAUNCH_UNCERTAIN", "state_uncertain": true] }
                guard launchError == nil, let app = launched else { throw AppFailure.code("APPLICATION_LAUNCH_FAILED") }
                return ["ok": true, "status": "opened", "application": try running(app.processIdentifier, bundle).1, "activation_requested": activate]
            case "quit":
                _ = try approvedApplication(request)
                guard let pid = request["pid"] as? Int32, let bundle = request["bundle_id"] as? String,
                      let expected = request["process_start"] as? String else { throw AppFailure.code("INVALID_REQUEST") }
                guard pid != getpid(), pid != getppid() else { throw AppFailure.code("PROTECTED_APPLICATION") }
                let (app, data) = try running(pid, bundle)
                guard data["process_start"] as? String == expected, data["path"] as? String == request["path"] as? String else { throw AppFailure.code("TARGET_CHANGED") }
                let accepted = app.terminate()
                let deadline = Date().addingTimeInterval(2)
                while accepted && !app.isTerminated && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
                return ["ok": true, "closed": app.isTerminated, "status": app.isTerminated ? "closed" : "needs_user_attention", "pid": pid,
                        "requires_user_attention": !app.isTerminated,
                        "message": app.isTerminated ? "应用已正常退出。" : "应用尚未退出，可能存在未保存内容或任务。请用户处理提示；不要自动丢弃或强制结束。"]
            default: throw AppFailure.code("INVALID_ACTION")
            }
        } catch AppFailure.detail(let code, let details) { return ["ok": false, "error_code": code, "diagnostics": details, "state_uncertain": false] }
        catch AppFailure.code(let code) { return ["ok": false, "error_code": code] }
        catch { return ["ok": false, "error_code": "APPLICATION_HELPER_FAILED"] }
    }
}
