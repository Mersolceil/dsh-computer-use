# Historical notes: 0.9 / 0.9.1 usability fixes

Browser open can reuse an existing exact URL, original same-origin SPA URL or sole same-origin tab when opening a website root. Ambiguous matches return issued tab IDs rather than creating another tab. Explicit reuse=false requests navigation. This operates only on the plugin-owned isolated browser.

Semantic reads include page content by default. New exact website/CDN/API origins can be approved through DSH for the owned browser session. Browser screenshots remain available independently of a failed accessibility read. These changes do not bypass network guards, authentication or site protection.

The macOS adapter added selected OS-window metadata/capture and requested Chromium/Electron accessibility exposure. A shell-only AX tree is not page content. Initial capture attempts selected a hidden internal window and produced black images. Graphical-session initialization, explicit geometry and readiness selection corrected the synthetic-window path; black/transparent image rejection remains.

0.12 supersedes the old on_screen screenshot gate: a selected window is attempted independently of foreground focus and partial display clipping. Refer to [current desktop setup](DESKTOP-CONTROL.md), [validation](VALIDATION.md) and [known limitations](KNOWN-LIMITATIONS.md).
