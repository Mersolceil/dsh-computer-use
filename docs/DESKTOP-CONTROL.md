# macOS desktop control — experimental AX adapter

This adapter controls an explicitly selected macOS application through Accessibility (AX). It is a separate DSH plugin. The browser plugin continues to use an isolated browser.

## Available operations

- `cu_desktop_attach({pid, bundleId})`: connect to a running, allowlisted application; returns a fresh tree.
- `cu_desktop_observe({})`: read roles and labels and issue fresh control references.
- `cu_desktop_click({target})`: perform AXPress on a control advertising this action.
- `cu_desktop_fill({target, text})`: set a writable plain text field.
- `cu_desktop_confirm({target})`: perform AXConfirm when advertised by the control.
- `cu_desktop_close({})`: terminate the helper and detach. The target application remains running.

After each action, observe again. References are local to the helper process and cleared after an action. Errors with `state_uncertain: true` may follow a partial side effect: inspect the application rather than retrying a submission. A successful AX call establishes tool execution; verify business completion independently.

Secure fields are marked protected and receive no actionable reference. The adapter reads AXValue only for AXStaticText status labels. It does not read editable values, activate applications, enumerate running apps, use the clipboard, inject global keyboard events, or capture screenshots. AXConfirm is a semantic action, not general keyboard input. Some applications do not expose the needed controls or actions. This experimental adapter is not a general visual desktop agent.

## Build and authorize

Requirements: macOS, Swift compiler/Xcode command-line tools, Node.js as specified in package.json, and DSH.

```sh
node scripts/build-desktop-helper.mjs --control
.artifacts/desktop-control-helper/DSHDesktopHelper.app/Contents/MacOS/DSHDesktopHelper --request-access
```

In System Settings → Privacy & Security → Accessibility, add and enable the exact app printed by the build command. A helper with the same display name may be an older build. Permission belongs to the helper's identity: do not replace an authorized app in place without checking whether macOS requires renewed authorization. The builder refuses to overwrite existing apps. This is an ad-hoc signed local build, not a notarized distribution.

Configure a separate DSH patch with the absolute path to your own build and an explicit bundle ID allowlist:

```yaml
- insert:
    - id: computer-use-desktop
      name: /ABSOLUTE/PATH/TO/PLUGIN/src/desktop-plugin.js
      config:
        helperPath: /ABSOLUTE/PATH/TO/PLUGIN/.artifacts/desktop-control-helper/DSHDesktopHelper.app/Contents/MacOS/DSHDesktopHelper
        allowedBundleIds: [org.dsh.fixture]
        maxActions: 100
```

The model must be given the authorized target PID and bundle ID. Do not allowlist personal applications until the isolated test has passed and you have explicitly chosen those applications.

## Verification

```sh
node --test test/desktop-session.test.js test/desktop-observer.test.js
node scripts/desktop-fixture-smoke.mjs --control
node scripts/desktop-fixture-smoke.mjs --control --stale-label
node scripts/desktop-fixture-smoke.mjs --control --dsh-fixture
node scripts/with-test-key.mjs scripts/desktop-fixture-smoke.mjs --control --dsh-real
```

The dedicated fixture contains synthetic data and records saves independently. The native test checks text input, exactly one save, stale-reference rejection and protected text exclusion. `--dsh-fixture` uses a local scripted Messages provider to drive the actual DSH agent and tool runtime; it does not measure autonomous model behavior. `--dsh-real` uses the provider configured for the isolated DSH run. `with-test-key.mjs` can obtain an authorized key through a hidden macOS dialog, keeping it out of source and reports.

A permission-required result is a failed prerequisite, not a passing desktop test. Reports under `.artifacts/desktop-eval` are local artifacts and must be reviewed before sharing. Real model tests consume API usage. Desktop operations are currently Native only; PTC, screenshot fallback, general keyboard/coordinate control, cancellation during an AX call and wider application coverage need additional validation before a stable desktop release.
