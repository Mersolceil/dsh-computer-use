import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { normalizeConfig } from '../src/browser.js'
import { chromium } from 'playwright'
import { browserInstallCommand, playwrightVersion } from '../src/runtime.js'

let report = { ok: false, node: process.version, playwright: playwrightVersion,
  probe_headless: true, credentials: 'Not read; DSH owns model authentication.' }
let json = process.argv.includes('--json')
let browser
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } })
  json = !!values.json
  if (values.help) {
    console.log('用法：npm run doctor -- [--config browser-config.json] [--json]\n检查 Node、插件配置，以及后台浏览器的真实渲染、点击和截图。\n--config 接收原始配置 JSON 对象，不是整份 DSH profile 或 YAML 补丁；不会保存或应用配置。\n始终无界面运行；不读取 DSH 凭据，不打开系统 Chrome。')
  } else {
    let input = {}
    if (values.config) {
      input = JSON.parse(await readFile(values.config, 'utf8'))
      const keys = new Set([...Object.keys(normalizeConfig()), 'executablePath'])
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置须为 JSON 对象')
      if (Object.keys(input).some(key => !keys.has(key))) throw Error('配置含未知字段；请对照 README 配置表核对拼写')
    }
    const config = normalizeConfig(input)
    // Never launch a personal browser application as a diagnostic fallback.
    // Custom executables need a separate, explicit operator check.
    if (config.executablePath) throw Error('doctor 只验证独立 Headless Shell；请先移除检查副本中的 executablePath。自定义可执行文件需要单独验证')
    report = { ...report, allowed_origins: config.allowedOrigins, upload_enabled: config.uploadRoots.length > 0,
      configured_headless: config.headless, probe_runtime: 'chromium-headless-shell',
      checks: { config: true, launch: false, click: false, screenshot: false } }
    browser = await chromium.launch({ channel: 'chromium-headless-shell', headless: true, chromiumSandbox: true, timeout: config.startupTimeoutMs })
    report.checks.launch = true
    report.browser_version = browser.version()
    const page = await browser.newPage()
    await page.setContent('<title>Browser ready</title><button onclick="document.querySelector(\'output\').textContent=\'clicked\'">Probe</button><output>waiting</output>')
    await page.getByRole('button', { name: 'Probe' }).click({ timeout: config.timeoutMs })
    if (await page.locator('output').textContent() !== 'clicked') throw Error('点击后页面结果未更新')
    report.checks.click = true
    const png = await page.screenshot({ timeout: config.timeoutMs })
    if (png.subarray(1, 4).toString() !== 'PNG') throw Error('截图未返回有效 PNG')
    report.checks.screenshot = true
    report.png_bytes = png.length
    report.ok = true
  }
} catch (error) {
  const missing = error.message.includes("Executable doesn't exist")
  report.error_code = missing ? 'BROWSER_MISSING' : report.checks?.config ? 'BROWSER_CHECK_FAILED' : 'CONFIG_INVALID'
  // Keep machine-readable stdout free of banners and stack traces.
  report.message = missing ? '缺少当前插件版本匹配的独立浏览器。' : error.message.split('\n')[0].slice(0, 500)
  report.next_step = missing ? browserInstallCommand : report.checks?.config
    ? '检查运行环境；如怀疑浏览器安装损坏，可重新运行：' + browserInstallCommand
    : '运行 npm run doctor -- --help，并对照 README 检查配置；本次未应用任何更改。'
  process.exitCode = missing ? 2 : 1
} finally {
  await browser?.close()
}
if (report.ok || report.error_code) {
  if (json) console.log(JSON.stringify(report, null, 2))
  else if (report.ok) console.log(`环境检查通过：Playwright ${playwrightVersion} / Headless Shell ${report.browser_version}\n后台启动、真实点击和 PNG 截图均成功。允许来源：${report.allowed_origins.join(', ')}\n上传${report.upload_enabled ? '已配置专用目录（本检查未验证目录或上传）' : '关闭'}。此检查不验证 DSH 启用状态、模型图片能力或外部网站。`)
  else console.error(`环境检查失败 [${report.error_code}]：${report.message}\n下一步：${report.next_step}`)
}
