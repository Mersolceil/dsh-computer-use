# macOS desktop setup — 0.12 alpha

The desktop adapter is separate from the browser bundle. Browser installation alone does not register the desktop tools. Visual capture/input requires macOS 14+, Swift/Xcode Command Line Tools and a DSH build exposing tools, attachments and approval services. The Native image policy also needs session projections and the host image-offload projection. Other DSH/platform versions are unverified.

## Build locally

```sh
git clone --branch v0.12.0-alpha.1 https://github.com/Mersolceil/dsh-computer-use.git
cd dsh-computer-use
npm ci --ignore-scripts
node scripts/build-desktop-helper.mjs --control --output-root .artifacts/desktop-helper-0.12
```

Keep the resulting app at a stable path. The builder refuses to overwrite an existing app so it does not silently replace a previously authorized signing identity. This is an ad-hoc signed local build, not a notarized distribution.

In System Settings → Privacy & Security, grant Accessibility for input and Screen Recording for capture to the exact responsible helper/DSH identity macOS presents. A terminal's permission result does not prove that the DSH process has the same permission. No tool grants itself OS permission. The helper supports `--permissions` for status; `--request-access` and `--request-screen-access` request the respective system prompts only when the user chooses to grant them.

## Register the desktop component

Back up your actual DSH profile configuration, then add a separate component using your own absolute paths:

```yaml
- insert:
    - id: computer-use-desktop
      name: /ABSOLUTE/PATH/TO/dsh-computer-use/src/desktop-plugin.js
      config:
        helperPath: /ABSOLUTE/PATH/TO/dsh-computer-use/.artifacts/desktop-helper-0.12/DSHDesktopHelper.app/Contents/MacOS/DSHDesktopHelper
        applicationAccess: standard
        observationMode: visual
        nativeApprovalEnabled: true
        imageMaxDimension: 1024
        imageHistoryLimit: 6
        imageHistoryKeep: 2
        maxActions: 100
```

`observationMode: visual` locks this component to screenshots and prevents AX observation/actions. Omit it to permit switching modes; leaving visual mode still needs approval. For strict application access, set `applicationAccess: allowlist` and provide `allowedBundleIds`. Standard mode permits ordinary apps selected by the task, not arbitrary credential/security actions.

Reload only when no task is using the component. Installed package version, loaded module version and helper version are separate facts. `cu_desktop_status` reports the actual plugin/helper and permissions; old helpers may require an upgrade.

## Workflow

Use `cu_desktop_start(application,purpose,control)` for background app reuse/opening, window selection, a bounded task approval, local preview and the first image. Ambiguous windows require selecting a returned window ID. Set control=true only for a task requiring input. Use `cu_desktop_step` for one image-grounded action and its resulting image, then revoke/close at completion.

The task grant binds the agent, process birth/path/fingerprint and one window. Default scope is 5 minutes/100 internal operations; a combined step's suboperations also count. Hard bounds are 15 minutes/200. Same-mode and same-task setup are idempotent without silently renewing limits. Closing the preview, ending/cancelling the turn, expiry or revocation ends the scope. Full-display capture and sensitive actions require separate decisions.

Preview images stay local and do not enter model history. The separate floating approval window answers only this plugin's exact pending DSH approval request. Rejection/closure/timeout/invalid reply never implies permission, and host never policy remains authoritative. Physical input may briefly foreground the target; if DSH was foreground before input, the helper requests returning focus afterwards. This is not an embedded remote desktop or a guarantee of background control.

AX tools remain available in semantic mode: attach/observe/click/fill/confirm/close. They exclude protected fields and editable values. AXConfirm is a semantic action, not a general keyboard shortcut. Known AX window/document-binding limits remain; consult KNOWN-LIMITATIONS.md.

## Minimal checks

Choose the check matching a change. Native integration uses disposable synthetic windows and may change foreground focus; do not run it against personal apps. No paid model is required.

```sh
node --test test/desktop-workflow.test.js test/desktop-images.test.js test/desktop-approval.test.js
```

The DSH SDK scripts use the installed macOS DSH Electron runtime (`ELECTRON_RUN_AS_NODE=1`). `desktop-context-smoke.cjs` checks host services without GUI/model calls. `desktop-workflow-smoke.cjs` takes an absolute helper executable and the PID of an already running, idle DSH; it uses a TTY and waits for coordinates chosen from its synthetic screenshots. Do not blindly supply coordinates from another image. See VALIDATION.md for evidence and limits.
