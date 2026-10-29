# DeepSeek Harness Computer Use

Accessibility-first browser tools and an experimental macOS desktop adapter for DeepSeek Harness. Version 0.7.0-alpha.1.

The existing DSH agent handles planning and tool calls. Browser operations use an isolated Playwright Chromium Headless Shell; desktop operations use a separately authorized, allowlisted native Accessibility helper.

## Install

Requires Node.js >=22.19.0 and DSH.

```sh
npm ci --ignore-scripts
npx --yes --package=playwright@1.63.0 playwright install chromium-headless-shell
npm run doctor
```

Install the local directory with DSH's third-party plugin installer, or run `dsh plugin --profile desktop add /ABSOLUTE/PATH/TO/PLUGIN`. Only configured exact browser origins are allowed; the default is the local lab at http://127.0.0.1:4173. Run `npm run lab` to start it. See the [browser guide](docs/PLUGIN-GUIDE.en.md) and [中文指南](docs/PLUGIN-GUIDE.zh.md). No npm package has been published.

## Features

- Browser: semantic observations and stable refs, tabs, navigation, form controls, bounded uploads, screenshots and guarded visual clicks.
- Memory: provenance-bearing facts and decisions, corrections, read-only history recall.
- Experimental, default-off options: incremental task state, Native/PTC history trimming, screenshot pins and offload, read-only budget estimates. These do not establish a hard request-token limit.
- macOS desktop: attach to an explicitly authorized PID and bundle ID, observe, click via AXPress, fill plain text, AXConfirm where supported, and detach. Follow the [desktop setup and test instructions](docs/DESKTOP-CONTROL.md). The helper must be built and authorized locally.

Desktop screenshots, global keyboard/mouse control and desktop PTC are not included. Secure fields are excluded. Application support depends on the exposed accessibility tree. This is an alpha release; test with the synthetic fixture before allowing personal applications.

## Verify

```sh
npm test
node scripts/desktop-fixture-smoke.mjs --control
node scripts/desktop-fixture-smoke.mjs --control --dsh-fixture
```

Browser model evaluation: `npm run eval:dsh -- --scenario long-context --mode native --variant baseline`. Supply your own authorized test key through the environment; never commit it. On macOS, `scripts/with-test-key.mjs` supports a hidden input dialog. API evaluations consume usage.

See [validation results](docs/VALIDATION.md) for the exact scope and limits of tested behavior. Local logs and generated helpers are excluded from this repository.

## License and authorship

MIT. Developed with AI assistance. Review the source and scope of each action before granting OS permissions. Third-party packages retain their own licenses.
