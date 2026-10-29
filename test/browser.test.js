import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserSession, normalizeConfig } from '../src/browser.js'
import { startLab } from '../eval/lab.js'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cu-test-'))
  const lab = await startLab({ port: 0 })
  const session = new BrowserSession({ headless: true, allowedOrigins: [lab.origin], artifactDir: dir, ...options })
  t.after(async () => { await session.shutdown(); await lab.close(); await rm(dir, { recursive: true, force: true }) })
  return { session, lab, open: () => session.run('open', { url: lab.origin }) }
}
function ref(result, name) {
  assert.equal(result.ok, true, JSON.stringify(result))
  const element = result.elements.find(e => e.name === name)
  assert.ok(element, `Missing control: ${name}`)
  return element.ref
}

test('configuration rejects ambiguous origins and invalid limits', () => {
  assert.throws(() => normalizeConfig({ allowedOrigins: ['https://example.com/path'] }))
  assert.throws(() => normalizeConfig({ allowedOrigins: [] }))
  assert.throws(() => normalizeConfig({ maxSteps: -1 }))
  assert.throws(() => normalizeConfig({ headless: 'false' }))
})

test('search uses observed refs and reads the real result', async t => {
  const { session: s, open } = await fixture(t)
  let v = await open()
  v = await s.run('fill', { target: ref(v, '关键词'), text: '浏览器' })
  v = await s.run('click', { target: ref(v, '搜索资料') })
  assert.match(v.text, /浏览器自动化入门：Playwright/)
})

test('form saves exactly once, confirmed independently on the server', async t => {
  const { session: s, lab, open } = await fixture(t)
  let v = await open()
  v = await s.run('fill', { target: ref(v, '标题'), text: '完成实验报告' })
  v = await s.run('fill', { target: ref(v, '描述'), text: '核对原始结果' })
  v = await s.run('click', { target: ref(v, '保存任务') })
  // Completion can be asynchronous; observe rather than repeat a submission.
  for (let i = 0; i < 10 && !v.text.includes('保存成功'); i++) v = await s.run('observe')
  assert.match(v.text, /保存成功/)
  assert.equal(lab.state.submissions, 1)
  assert.deepEqual(lab.state.last, { title: '完成实验报告', description: '核对原始结果' })
})

test('old refs are rejected after an action; stale failure returns a fresh observation', async t => {
  const { session: s, open } = await fixture(t)
  const first = await open()
  const old = ref(first, '目标按钮')
  await s.run('click', { target: ref(first, '替换目标按钮') })
  const failed = await s.run('click', { target: old })
  assert.equal(failed.error_code, 'STALE_TARGET')
  const v = await s.run('click', { target: ref({ ok: true, ...failed.observation }, '目标按钮') })
  assert.match(v.text, /已点击目标按钮/)
})

test('a replaced DOM node cannot be clicked through its old handle', async t => {
  const { session: s, open } = await fixture(t)
  const v = await open()
  const old = ref(v, '目标按钮')
  // Simulates an app-driven update, without a plugin action refreshing refs.
  await s.page.evaluate(() => document.getElementById('replace').click())
  const failed = await s.run('click', { target: old })
  assert.equal(failed.error_code, 'STALE_TARGET')
  assert.equal(await s.page.locator('#targetResult').innerText(), '尚未点击')
})

test('overlay blocks a click; dismissing it recovers without force-click', async t => {
  const { session: s, open } = await fixture(t, { timeoutMs: 400 })
  let v = await open()
  v = await s.run('click', { target: ref(v, '打开遮挡弹窗') })
  const failed = await s.run('click', { target: ref(v, '目标按钮') })
  assert.equal(failed.error_code, 'ACTION_TIMEOUT')
  assert.equal(await s.page.locator('#targetResult').innerText(), '尚未点击')
  v = await s.run('observe')
  v = await s.run('click', { target: ref(v, '关闭弹窗') })
  v = await s.run('click', { target: ref(v, '目标按钮') })
  assert.match(v.text, /已点击目标按钮/)
})

test('slow UI update does not cause duplicate submission', async t => {
  const { session: s, lab, open } = await fixture(t)
  let v = await open()
  v = await s.run('click', { target: ref(v, '提交一次并等待较慢结果') })
  for (let i = 0; i < 10 && !v.text.includes('服务器已接收'); i++) v = await s.run('observe')
  assert.match(v.text, /服务器已接收/)
  assert.equal(lab.state.submissions, 1)
})

test('screenshot contains real PNG bytes in viewport CSS pixels', async t => {
  const { session: s, open } = await fixture(t)
  await open()
  const v = await s.run('screenshot')
  assert.equal(v.ok,true,JSON.stringify(v))
  const png = Buffer.from(v.screenshot.data, 'base64')
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 1280)
  assert.equal(png.readUInt32BE(20), 720)
})

test('navigation, redirects and ordinary cross-origin subrequests are denied', async t => {
  const { session: s, lab, open } = await fixture(t)
  await open()
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://example.com', lab.origin.replace('127.0.0.1', 'localhost')]) {
    assert.equal((await s.run('open', { url })).error_code, 'ORIGIN_DENIED')
  }
  const reached = []
  const forbidden = await startLab({ port: 0 })
  t.after(() => forbidden.close())
  forbidden.server.on('request', r => reached.push(r.url))
  await s.page.evaluate(async origin => { try { await fetch(origin + '/api/state') } catch {} }, forbidden.origin)
  assert.equal(reached.length, 0)
  assert.ok((await s.run('observe')).blocked_origins.includes(forbidden.origin))
  const redirected = await s.run('open', { url: lab.origin + '/redirect?to=' + encodeURIComponent(forbidden.origin) })
  assert.equal(redirected.ok, false)
  assert.equal(reached.length, 0, 'A redirect must not bypass the request origin policy')
})

test('pre-cancelled calls never start a browser', async t => {
  const { session: s, lab } = await fixture(t)
  const c = new AbortController(); c.abort()
  assert.equal((await s.run('open', { url: lab.origin }, { signal: c.signal })).error_code, 'ABORTED')
  assert.equal(s.browser, undefined)
})

test('in-flight cancellation closes browser and prevents later actions', async t => {
  const { session: s, open } = await fixture(t)
  let v = await open()
  v = await s.run('click', { target: ref(v, '打开遮挡弹窗') })
  const c = new AbortController()
  const pending = s.run('click', { target: ref(v, '目标按钮') }, { signal: c.signal })
  setTimeout(() => c.abort(), 100)
  const failed = await pending
  assert.equal(failed.error_code, 'ABORTED')
  assert.equal(s.browser, undefined)
  assert.equal((await s.run('observe')).error_code, 'SESSION_CLOSED')
})

test('step budget and concurrent-call rejection', async t => {
  const { session: s, open } = await fixture(t, { maxSteps: 3 })
  const pending = open()
  assert.equal((await s.run('observe')).error_code, 'BUSY')
  await pending
  await s.run('observe'); await s.run('observe')
  assert.equal((await s.run('observe')).error_code, 'STEP_LIMIT')
  assert.equal((await s.run('close')).closed, true)
})

test('native dialogs are dismissed and reported; invalid keys do not execute', async t => {
  const { session: s, open } = await fixture(t)
  let v = await open()
  v = await s.run('click', { target: ref(v, '打开原生提示') })
  assert.equal(v.dialog.type, 'alert')
  assert.equal(v.dialog.dismissed, true)
  assert.equal((await s.run('press', { key: 'ControlOrMeta+L' })).error_code, 'INVALID_KEY')
})

test('trace correlates actions, observations and failures without screenshot base64', async t => {
  const { session: s, open } = await fixture(t)
  await open(); await s.run('screenshot'); await s.run('click', { target: 'invented' })
  const data = await readFile(s.tracePath, 'utf8')
  const rows = data.trim().split('\n').map(JSON.parse)
  assert.ok(rows.some(r => r.type === 'action'))
  assert.ok(rows.some(r => r.type === 'observation'))
  assert.ok(rows.some(r => r.error_code === 'STALE_TARGET'))
  assert.ok(rows.every(r => r.trace_id === s.traceId))
  assert.ok(!data.includes('iVBOR'))
})

test('fresh sessions do not inherit cookies or localStorage', async t => {
  const first = await fixture(t)
  await first.open()
  await first.session.page.evaluate(() => { localStorage.setItem('private', 'value'); document.cookie = 'token=secret' })
  await first.session.shutdown()
  const second = new BrowserSession({ headless: true, allowedOrigins: [first.lab.origin], artifactDir: first.session.config.artifactDir })
  t.after(() => second.shutdown())
  await second.run('open', { url: first.lab.origin })
  assert.deepEqual(await second.page.evaluate(() => [localStorage.getItem('private'), document.cookie]), [null, ''])
})

test('closing during browser startup leaves no browser process owned by the session', async t => {
  const { session: s, lab } = await fixture(t)
  const pending = s.run('open', { url: lab.origin })
  const c = setTimeout(() => { void s.shutdown() }, 5)
  t.after(() => clearTimeout(c))
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(s.stopped, true)
  assert.ok(!s.browser || !s.browser.isConnected())
})
