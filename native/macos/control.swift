import ApplicationServices
import AppKit
import Darwin
import Foundation

// Target-bound JSON-lines service. No app enumeration, activation, global
// events, screenshots, shell execution, clipboard access or secure values.
func send(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8))
}
if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--request-access" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let granted = AXIsProcessTrustedWithOptions(options)
    send(["ok": granted, "status": granted ? "granted" : "permission_required"]); exit(granted ? 0 : 3)
}
guard CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--serve",
      let pid = Int32(CommandLine.arguments[2]), pid > 0 else {
    send(["ok": false, "error_code": "TARGET_REQUIRED"]); exit(2)
}
let bundle = CommandLine.arguments[3]
func startTime() -> String? {
    var info = proc_bsdinfo(); let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    let count = withUnsafeMutablePointer(to: &info) { proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, $0, size) }
    return count == size && info.pbi_start_tvsec > 0 ? "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)" : nil
}
let initialStart = startTime()
func identity() -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
          app.bundleIdentifier == bundle, let initial = initialStart else { return false }
    return startTime() == initial
}
guard identity() else { send(["ok": false, "error_code": "TARGET_IDENTITY_MISMATCH"]); exit(4) }
guard AXIsProcessTrusted() else { send(["ok": false, "error_code": "ACCESSIBILITY_PERMISSION_REQUIRED"]); exit(3) }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 0.25)
var refs: [String: AXUIElement] = [:]
var refKinds: [String: String] = [:]
var refLabels: [String: String] = [:]
var generation = 0
var fatalTree = false
func owned(_ element: AXUIElement) -> Bool {
    var owner: pid_t = 0
    return AXUIElementGetPid(element, &owner) == .success && owner == pid
}
func attr(_ element: AXUIElement, _ key: CFString) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key, &raw) == .success, let text = raw as? String, !text.isEmpty else { return nil }
    return String(text.prefix(256))
}
func actions(_ element: AXUIElement) -> [String] {
    var raw: CFArray?
    guard AXUIElementCopyActionNames(element, &raw) == .success else { return [] }
    return raw as? [String] ?? []
}
func labels(_ element: AXUIElement) -> String {
    return (attr(element, kAXTitleAttribute as CFString) ?? "") + "\u{0}" + (attr(element, kAXDescriptionAttribute as CFString) ?? "")
}
func secure(_ element: AXUIElement) -> Bool {
    let role = attr(element, kAXRoleAttribute as CFString)
    let subrole = attr(element, kAXSubroleAttribute as CFString)
    return role == "AXSecureTextField" || subrole == "AXSecureTextField"
}
func fillable(_ element: AXUIElement) -> Bool {
    guard !secure(element), let role = attr(element, kAXRoleAttribute as CFString), ["AXTextField", "AXTextArea"].contains(role) else { return false }
    var writable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue
}
func reachable(_ target: AXUIElement) -> Bool {
    // Verify a retained element still leads to this application. Detached or
    // reparented controls must not be acted on after a UI replacement.
    var current = target
    for _ in 0..<32 {
        guard owned(current) else { return false }
        if CFEqual(current, app) { return true }
        var parent: CFTypeRef?
        guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
              let raw = parent, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return false }
        current = unsafeBitCast(raw, to: AXUIElement.self)
    }
    return false
}
func observe() -> [String: Any] {
    refs.removeAll(); refKinds.removeAll(); refLabels.removeAll(); generation += 1; fatalTree = false
    var nodes = 0, truncated = false
    var seen: [AXUIElement] = []
    let deadline = ProcessInfo.processInfo.systemUptime + 4
    func visit(_ element: AXUIElement, _ depth: Int) -> [String: Any]? {
        guard depth <= 8, nodes < 200, ProcessInfo.processInfo.systemUptime < deadline else { truncated = true; return nil }
        guard owned(element) else { fatalTree = true; return nil }
        guard !seen.contains(where: { CFEqual($0, element) }) else { fatalTree = true; return nil }
        seen.append(element)
        nodes += 1
        let role = attr(element, kAXRoleAttribute as CFString) ?? "unknown"
        var row: [String: Any] = ["role": role]
        if secure(element) { row["protected"] = true; return row }
        if let title = attr(element, kAXTitleAttribute as CFString) { row["title"] = title }
        if let description = attr(element, kAXDescriptionAttribute as CFString) { row["description"] = description }
        // AppKit status labels expose their visible text through AXValue.
        // Read it only for static labels, never editable or secure controls.
        if role == "AXStaticText", let text = attr(element, kAXValueAttribute as CFString) { row["text"] = text }
        let available = actions(element)
        var supported: [String] = []
        if available.contains(kAXPressAction as String) { supported.append("click") }
        if available.contains(kAXConfirmAction as String) { supported.append("confirm") }
        if fillable(element) { supported.append("fill") }
        if !supported.isEmpty {
            let ref = "g\(generation):\(UUID().uuidString)"
            refs[ref] = element; refKinds[ref] = role; refLabels[ref] = labels(element); row["ref"] = ref; row["actions"] = supported
        }
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success, let children = raw as? [AXUIElement] {
            var output: [[String: Any]] = []
            for child in children { if let item = visit(child, depth + 1) { output.append(item) } else { break } }
            if !output.isEmpty { row["children"] = output }
        }
        return row
    }
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success, let windows = raw as? [AXUIElement] else {
        return ["ok": false, "error_code": "WINDOWS_UNAVAILABLE"]
    }
    guard windows.allSatisfy({ owned($0) && attr($0, kAXRoleAttribute as CFString) == "AXWindow" }) else {
        return ["ok": false, "error_code": "WINDOWS_NOT_READY"]
    }
    var output: [[String: Any]] = []
    for window in windows { if let row = visit(window, 0) { output.append(row) } else { break } }
    guard identity(), !fatalTree else { refs.removeAll(); return ["ok": false, "error_code": "TARGET_CHANGED_OR_FOREIGN_ELEMENT"] }
    return ["ok": true, "pid": pid, "bundle_id": bundle, "generation": generation, "windows": output, "nodes": nodes, "truncated": truncated, "editable_values_read": false, "static_text_values_read": true]
}
send(["ok": true, "ready": true, "pid": pid, "bundle_id": bundle])
while let line = readLine() {
    guard line.utf8.count <= 65536, let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = request["id"] as? Int, let action = request["action"] as? String else { send(["ok": false, "error_code": "INVALID_REQUEST"]); continue }
    var result: [String: Any]
    if action == "close" { send(["id": id, "ok": true, "closed": true]); break }
    if !identity() { send(["id": id, "ok": false, "error_code": "TARGET_CHANGED"]); break }
    if action == "observe" { result = observe() }
    else if ["click", "fill", "confirm"].contains(action), let ref = request["target"] as? String, let element = refs[ref] {
        if !reachable(element) || secure(element) || attr(element, kAXRoleAttribute as CFString) != refKinds[ref] || labels(element) != refLabels[ref] {
            refs.removeAll(); result = ["ok": false, "error_code": "STALE_OR_PROTECTED_TARGET"]
        } else {
            var status = AXError.actionUnsupported
            if action == "fill", let text = request["text"] as? String, text.count <= 10000, fillable(element) {
                status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString)
            } else if action != "fill" {
                let nativeAction = action == "click" ? kAXPressAction : kAXConfirmAction
                if actions(element).contains(nativeAction as String) { status = AXUIElementPerformAction(element, nativeAction as CFString) }
            }
            refs.removeAll(); refKinds.removeAll(); refLabels.removeAll()
            // Even an AX error can follow a partial side effect. Never retry
            // an uncertain submission automatically.
            if status == .success && identity() { result = ["ok": true, "action": action, "verification_scope": "tool_execution", "requires_observation": true] }
            else { result = ["ok": false, "error_code": "ACTION_RESULT_UNCERTAIN", "state_uncertain": true, "ax_status": status.rawValue] }
        }
    } else { result = ["ok": false, "error_code": "INVALID_ACTION_OR_REF"] }
    result["id"] = id; send(result)
}
