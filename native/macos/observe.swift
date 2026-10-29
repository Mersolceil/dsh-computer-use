import ApplicationServices
import AppKit
import Darwin
import Foundation

// Experimental read-only probe. No prompts, focus changes, values or actions.
// The caller must provide both a positive PID and its expected bundle ID.
// This does not enumerate applications or activate the target.
func emit(_ object: [String: Any], code: Int32 = 0) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

// Explicit setup command only; normal observations never request permission.
if CommandLine.arguments == [CommandLine.arguments[0], "--request-access"] {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let granted = AXIsProcessTrustedWithOptions(options)
    emit(["ok": granted, "status": granted ? "granted" : "permission_required"], code: granted ? 0 : 3)
}

guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      !CommandLine.arguments[2].isEmpty, CommandLine.arguments[2].count <= 255 else {
    emit(["ok": false, "error": "TARGET_REQUIRED"], code: 2)
}
let expectedBundle = CommandLine.arguments[2]
// NSRunningApplication.launchDate is nil for some directly launched app
// bundles. Kernel process start time also provides an identity across checks.
func processStart(_ pid: Int32) -> String? {
    var info = proc_bsdinfo()
    let expected = Int32(MemoryLayout<proc_bsdinfo>.size)
    let count = withUnsafeMutablePointer(to: &info) {
        proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, expected)
    }
    guard count == expected, info.pbi_start_tvsec > 0 else { return nil }
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}
let candidate = NSRunningApplication(processIdentifier: pid)
guard let target = candidate,
      !target.isTerminated, target.bundleIdentifier == expectedBundle,
      let start = processStart(pid) else {
    emit(["ok": false, "error": "TARGET_IDENTITY_MISMATCH", "target_found": candidate != nil,
          "bundle_matches": candidate?.bundleIdentifier == expectedBundle,
          "start_time_available": processStart(pid) != nil], code: 4)
}
guard AXIsProcessTrusted() else {
    emit(["ok": false, "error": "ACCESSIBILITY_PERMISSION_REQUIRED"], code: 3)
}
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.5)
var role: CFTypeRef?
let status = AXUIElementCopyAttributeValue(app, kAXRoleAttribute as CFString, &role)
guard status == .success, let name = role as? String, name == kAXApplicationRole else {
    emit(["ok": false, "error": "APPLICATION_UNAVAILABLE", "ax_status": status.rawValue], code: 4)
}
// Only traverse windows belonging to the explicitly selected process. The
// caller must treat all names as untrusted task data. Values are never read.
var rawWindows: CFTypeRef?
let windowsStatus = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows)
guard windowsStatus == .success, let windows = rawWindows as? [AXUIElement] else {
    emit(["ok": false, "error": "WINDOWS_UNAVAILABLE", "ax_status": windowsStatus.rawValue], code: 5)
}
let nodeLimit = 200, depthLimit = 8
let deadline = ProcessInfo.processInfo.systemUptime + 5
var visited = 0, truncated = false, timedOut = false, foreignElement = false
func stringAttribute(_ element: AXUIElement, _ key: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key, &value) == .success,
          let text = value as? String, !text.isEmpty else { return nil }
    return String(text.prefix(256))
}
func visit(_ element: AXUIElement, _ depth: Int) -> [String: Any]? {
    guard ProcessInfo.processInfo.systemUptime < deadline else { truncated = true; timedOut = true; return nil }
    guard visited < nodeLimit else { truncated = true; return nil }
    // Embedded remote views may expose elements belonging to another process.
    // Check before reading any attributes and reject the entire observation if
    // the owner is unknown or differs from the explicit target.
    var elementPID: pid_t = 0
    guard AXUIElementGetPid(element, &elementPID) == .success, elementPID == pid else {
        foreignElement = true
        return nil
    }
    visited += 1
    var node: [String: Any] = ["role": stringAttribute(element, kAXRoleAttribute as CFString) ?? "unknown"]
    if let title = stringAttribute(element, kAXTitleAttribute as CFString) { node["title"] = title }
    if let description = stringAttribute(element, kAXDescriptionAttribute as CFString) { node["description"] = description }
    var rawChildren: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren) == .success,
       let children = rawChildren as? [AXUIElement], !children.isEmpty {
        if depth >= depthLimit { truncated = true }
        else {
            var output: [[String: Any]] = []
            for child in children {
                guard let item = visit(child, depth + 1) else { break }
                output.append(item)
            }
            if !output.isEmpty { node["children"] = output }
        }
    }
    return node
}
var output: [[String: Any]] = []
for window in windows {
    guard let item = visit(window, 0) else { break }
    output.append(item)
}
guard !foreignElement else {
    emit(["ok": false, "error": "FOREIGN_ELEMENT_OR_OWNER_UNKNOWN"], code: 4)
}
// Detect a process exit or PID reuse that occurred during the traversal.
guard let current = NSRunningApplication(processIdentifier: pid),
      !current.isTerminated, current.bundleIdentifier == expectedBundle,
      processStart(pid) == start else {
    emit(["ok": false, "error": "TARGET_CHANGED"], code: 4)
}
emit(["ok": true, "pid": pid, "bundle_id": expectedBundle, "role": name, "windows": output, "nodes": visited, "truncated": truncated, "timed_out": timedOut, "values_read": false])
