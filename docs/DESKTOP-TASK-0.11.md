# Historical notes: 0.11 bounded tasks

Current setup is in [DESKTOP-CONTROL.md](DESKTOP-CONTROL.md), with the preferred [0.12 workflow](DESKTOP-WORKFLOW-0.12.md).

0.11 added an explicit task grant bound to one agent, app process birth/path/fingerprint and window. Defaults were 5 minutes and 100 internal actions, with hard maxima of 15 minutes/200. Task approval did not authorize other windows, whole-display capture, AX, quitting apps or sensitive actions. Closing the local preview or revoking/ending/cancelling a task removed the grant.

Window capture became independent of foreground focus and display clipping. Native input restored focus within its transaction and checked a fresh bound image. Pure window movement could be rebased only after size and image checks. A nonactivating native preview refreshed the selected window locally every two seconds.

The accepted synthetic DSH workflow used 15 exposed calls and one scripted task-approval audit pair. Its fixture independently confirmed a real click, exact Chinese/emoji/multiline input, one new note and one save, including a partially off-display window and DSH foreground interference. It did not establish personal-app compatibility, human Allow integration or general cost savings.

0.12 supersedes this flow with start/step, a floating approval answerer and Native desktop image history. It also fixes the optional-preview undefined field that could make a successful grant fail lossless JSON output validation.
