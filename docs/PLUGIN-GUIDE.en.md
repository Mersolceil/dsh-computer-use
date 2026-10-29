# Using browser computer use

Let the existing DSH agent operate an isolated browser through accessibility references. It supports forms, tabs, history, screenshots and controlled file uploads. The default standalone headless runtime does not open the Chrome app or import personal browser sessions. This guide covers the browser component. A separate experimental macOS desktop adapter is documented in [desktop setup](DESKTOP-CONTROL.md). Downloads and manual login handoff are not implemented.

## First run

1. After installation, choose **Enable now** and check that the component is running. First installation can apply live. After replacing an installed version, if activation fails, finish running tasks and restart DSH once, then check the component again.
2. Install the matching browser runtime separately:

```sh
npx --yes --package=playwright@1.63.0 playwright install chromium-headless-shell
```

3. In the source project, run `npm run lab` and keep it running.
4. Start a new DSH conversation and ask:

> Use only cu_browser tools to open http://127.0.0.1:4173. Search for 浏览器 and read the results. Create one task with title 完成实验报告 and description 核对原始结果. Save exactly once, verify the page result, take a screenshot, then close the browser.

Check the tool trajectory and the saved page result. A final answer alone is not evidence of completion. Screenshots are real DSH image attachments; interpreting them requires a model and provider configured for images.

## Other sites and uploads

The default origin allowlist contains only `http://127.0.0.1:4173`. This plugin currently has **no graphical configuration form**. Merge this row into the current profile's `cordis.patch.yml`, preserving existing entries:

```yaml
- id: computer-use-v1
  config:
    headless: true
    allowedOrigins:
      - http://127.0.0.1:4173
      - https://example.org
```

Origins contain a protocol, host and optional port, with no path, trailing slash or wildcard. Review additional resource origins before allowing them. Confirm plugin reload and start a new browser session after changes. The origin guard is not an OS firewall.

Uploads default to disabled. Configure `uploadRoots` with existing dedicated absolute directories and place only intended files there. Click the page's file chooser using its accessibility reference, then pass its issued `chooser_id` and explicit absolute file paths to `cu_browser_upload`. Selection can trigger automatic submission; inspect results before trying again.

## Troubleshooting

| Problem | Next step |
|---|---|
| Tools absent | Enable the bundle and component; inspect a new conversation's tool trajectory |
| `BROWSER_MISSING` | Run the pinned browser installation command above, then retry |
| `ORIGIN_DENIED` | Review the exact rejected origin and the active profile's allowlist |
| `STALE_TARGET` / `WRONG_TAB` | Observe again or select the reference's tab; use issued references |
| Timed out submission | Inspect the page or wait for its exact status text before retrying |
| Image rejected | Check model/provider image support; use accessibility references for ordinary controls |

From the source directory, `npm run doctor` verifies real background rendering, a click and PNG capture. Add `-- --json` for a machine-readable report, or `-- --config browser-config.json` to validate a raw JSON configuration object. It does not save settings, read DSH credentials or verify DSH enablement. Custom executables need a separate operator check.

This is a release candidate. Passing the bundled practice tasks does not establish success on arbitrary websites. The delivered source contains evaluation instructions and historical reports.
