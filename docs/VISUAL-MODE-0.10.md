# Historical notes: 0.10 visual mode

Current setup is in [DESKTOP-CONTROL.md](DESKTOP-CONTROL.md); use [0.12 workflow](DESKTOP-WORKFLOW-0.12.md) for the preferred task flow.

0.10 introduced screenshot-only mode, helper status, focus requests, full-display capture, limited keyboard shortcuts, Unicode typing, pixel clicks and scrolling. Visual mode blocks this plugin's AX attach/observe/click/fill/confirm tools; it does not intercept unrelated plugins.

A screenshot ticket is agent/process/window-bound, expires after 60 seconds and allows one attempted input. The native helper refreshes the actual image before input and checks coarse image content, target identity, geometry and mouse hit routing. A coarse guard is not pixel-level or semantic proof. Unicode input uses Quartz events rather than clipboard or AXSetValue.

The local synthetic editor accepted Chinese, emoji and multiline input with one actual mouse click and one save. Old PID-directed mouse events had returned success without reaching the editor; OS mouse routing and independent receive counters caught and corrected that failure. This established one fixture path, not arbitrary application support.

0.10 used per-action approvals; 0.11 added a bounded task grant. Current full-display, sensitive-action, animation and platform limits are in [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).
