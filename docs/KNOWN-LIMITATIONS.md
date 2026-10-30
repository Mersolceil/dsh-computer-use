# Known limitations — 0.12.0-alpha.1

This is an alpha release. A successful tool result establishes only its stated scope, not general application support or business completion.

- Desktop image guards are coarse and can miss small changes. Video, animation or carousel changes can also trigger repeated SCREENSHOT_CHANGED errors. Do not loop retries, disable all guards or infer that a static button is safe because its application was approved.
- The floating preview and approval windows are native auxiliary windows, not panels embedded in DSH. Actual mouse/keyboard input may briefly foreground the target; returning to DSH is a request subject to macOS activation rules.
- Minimized/other-Space window recovery, multiple displays, arbitrary apps, real human allow-button integration and long-duration preview stability have not been comprehensively accepted. Native integration evidence uses synthetic apps and scripted task approvals; a synthetic rejection button was also exercised.
- The desktop image policy covers attributable Native tool results. Unknown/PTC images are left alone. Historical image lookup retains a bounded index, and attachment availability depends on the host store.
- API prefix-cache hits and image-history reduction are distinct. Offloading old images changes the request prefix. No monetary saving or universal autonomous success rate is established.
- Browser origin approval gates website access; browser clicks/typing are not independently protected by the desktop task-approval mechanism. Do not treat origin approval as a complete sensitive-action safeguard.
- Browser tab close currently bypasses beforeunload and can discard unsaved drafts. Pending-origin-approval disposal and some post-effect network-error uncertainty classifications remain under review. Do not blindly repeat writes after an error.
- AX references are not fully bound to a document/window context. Selecting an app or reading a shell AX tree does not prove the intended document or web content was observed.
- No automatic credentials, CAPTCHA, protected-content bypass, force-quit or automatic approval is provided. Users must configure and review the permissions appropriate to their tasks.
