import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwrightVersion, browserInstallCommand } from '../src/runtime.js'
const script = fileURLToPath(new URL('../scripts/doctor.js', import.meta.url))
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cu-doctor-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
function run(cwd, args = [], env = {}) {
  const child = spawnSync(process.execPath, [script, '--json', ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 45000 })
  assert.ifError(child.error)
  assert.equal(child.stderr, '', 'JSON mode should not emit banners or stacks')
  return { code: child.status, report: JSON.parse(child.stdout) }
}
test('runtime repair command stays pinned to the exact published dependency', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(playwrightVersion, pkg.dependencies.playwright)
  assert.match(playwrightVersion, /^\d+\.\d+\.\d+$/)
})
test('doctor verifies real background click and PNG without depending on workspace packages', async t => {
  const dir = await workspace(t)
  const config = join(dir, 'config.json')
  await writeFile(config, JSON.stringify({ headless: false, allowedOrigins: ['https://example.org'] }))
  const { code, report } = run(dir, ['--config', config])
  assert.equal(code, 0)
  assert.equal(report.ok, true)
  assert.equal(report.probe_headless, true, 'even visible configs must be probed without opening the Dock')
  assert.equal(report.configured_headless, false)
  assert.deepEqual(report.checks, { config: true, launch: true, click: true, screenshot: true })
  assert.ok(report.png_bytes > 100)
  assert.deepEqual(report.allowed_origins, ['https://example.org'])
})
test('doctor rejects malformed, mistyped and unsupported config before starting a browser', async t => {
  const dir = await workspace(t), config = join(dir, 'config.json')
  for (const value of ['null', '[]', '{', '{"allowedOrigin":["https://example.org"]}', '{"allowedOrigins":["https://example.org/path"]}', '{"executablePath":"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}']) {
    await writeFile(config, value)
    const { code, report } = run(dir, ['--config', config], { PLAYWRIGHT_BROWSERS_PATH: join(dir, 'absent') })
    assert.equal(code, 1)
    assert.equal(report.error_code, 'CONFIG_INVALID')
    assert.equal(report.checks, undefined)
  }
  const result = run(dir, ['--unknown'])
  assert.equal(result.code, 1)
  assert.equal(result.report.error_code, 'CONFIG_INVALID')
})
test('missing runtime diagnosis pins the installed Playwright version from an unrelated workspace', async t => {
  const dir = await workspace(t)
  const { code, report } = run(dir, [], { PLAYWRIGHT_BROWSERS_PATH: join(dir, 'absent') })
  assert.equal(code, 2)
  assert.equal(report.error_code, 'BROWSER_MISSING')
  assert.equal(report.next_step, browserInstallCommand)
  assert.ok(report.next_step.includes(`--package=playwright@${playwrightVersion}`))
  assert.deepEqual(report.checks, { config: true, launch: false, click: false, screenshot: false })
})
test('actual browser open gives the same pinned repair command when its runtime is missing', async t => {
  const dir = await workspace(t)
  const source = new URL('../src/browser.js', import.meta.url).href
  const code = `const {BrowserSession}=await import(${JSON.stringify(source)});const s=new BrowserSession({artifactDir:${JSON.stringify(dir)}});try{console.log(JSON.stringify(await s.run('open',{url:'http://127.0.0.1:4173'})))}finally{await s.shutdown()}`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dir, 'absent') }, encoding: 'utf8', timeout: 45000 })
  assert.ifError(child.error)
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(child.stdout)
  assert.equal(result.error_code, 'BROWSER_MISSING')
  assert.ok(result.message.includes(browserInstallCommand))
})
