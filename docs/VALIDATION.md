# Validation — 0.12.0-alpha.1

These results describe a local synthetic configuration, not a general success rate. Previously applicable results were reused; no full regression or new paid-model evaluation was added for this release.

| Check | Evidence | Limit |
|---|---|---|
| Related local checks | 10 passed across workflow, grant, visual ticket, image policy and approval transport cases | Unit-level checks; not all project tests |
| Actual DSH services | Native approval seam priority and never policy, 3 audit pairs, lossless authorize output, 7 images reduced to 2, recall, replay and pending-input deferral passed | Synthetic session; approval transport substituted |
| Screenshot-only desktop workflow | 6 exposed tool calls: start, four steps, revoke; one new note, one received mouse click, exact Chinese/emoji/multiline text and one save | Disposable AppKit editor; no personal app |
| Focus and images | DSH foreground checked five times, every input returned to it; four new image deliveries and one exact image reuse | One local desktop setup |
| Approval UI | Actual floating panel captured and synthetic Reject button exercised; matched request ID returned rejected | No real control request or human Allow acceptance |
| Native helper | Compiled and ad-hoc signature verified | Local build, not notarized distribution |

The integration used the real DSH ToolRuntime, ApprovalService and LocalAttachmentStore. The fixture window was deliberately partly outside the display. Two scripted approvals covered the nonstandard fixture application path and the task scope; one scope approval for a conventional installed app was separately checked in units. AX/HTML/clipboard reads were zero in the screenshot-only fixture workflow. The final saved image was inspected.

Retained failures included invalid synthetic PNG data rejected by the real attachment store, a locked-session preflight, an early check-script branch mistake, and an assertion expecting absent isError where the SDK returned false. Each cause was recorded and corrected; none was counted as success. The authorize bug that returned an undefined optional preview field after creating a grant was fixed and tested at the actual ToolRuntime lossless-JSON boundary.

Earlier versions also encountered window-readiness races, hidden internal-window selection, black captures, unsuccessful event delivery and a preview overlapping a click target. The current implementation retains identity, capture and hit-target guards. These corrections do not prove compatibility with every app or solve animated-page guarding.

No new paid model/API call was made for these checks. See [known limitations](KNOWN-LIMITATIONS.md), [desktop setup](DESKTOP-CONTROL.md) and [workflow details](DESKTOP-WORKFLOW-0.12.md).

## Publication scope

The public tree contains source, synthetic fixtures and summarized validation. Personal usage statistics, credentials, raw session/provider logs, captured UI images, helper binaries, internal continuation/install records and caches are excluded. The single PNG fixture is a generated checkerboard, not a desktop capture. Existing public Git history and the new change are checked separately for common credential patterns and personal paths; heuristic scans cannot prove the absence of every sensitive string.
