import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { BrowserSession, normalizeConfig } from '../src/browser.js'
import { startLab } from '../eval/lab.js'

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cu-upload-'))
  const allowed = join(dir, 'allowed'), outside = join(dir, 'allowed-other')
  await mkdir(allowed); await mkdir(outside)
  const lab = await startLab({ port: 0 })
  const s = new BrowserSession({ uploadRoots: [allowed], allowedOrigins: [lab.origin], artifactDir: join(dir, 'logs'), ...config })
  t.after(async () => { await s.shutdown(); await lab.close(); await rm(dir, { recursive: true, force: true }) })
  const opened = await s.run('open', { url: lab.origin + '/uploads' })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const put = async (name, content, root = allowed) => { const path = join(root, name); await writeFile(path, content); return path }
  const choose = async () => {
    const view = await s.run('observe')
    const value = await s.run('click', { target: ref(view, '选择待上传文件') })
    assert.equal(value.ok, true, JSON.stringify(value))
    assert.equal(value.file_choosers.length, 1, JSON.stringify(value))
    return value.file_choosers[0].chooser_id
  }
  return { s, lab, dir, allowed, outside, put, choose }
}
function ref(value, name) { const node = value.elements?.find(e => e.name === name); assert.ok(node, 'Missing ' + name); return node.ref }

test('binary payloads preserve exact bytes and file metadata in the native File object', async t => {
  const { s, put, choose } = await fixture(t)
  const bytes = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))
  const path = await put('sample.png', bytes), chooser_id = await choose()
  const selected = await s.run('upload', { chooser_id, files: [path] })
  assert.equal(selected.ok, true, JSON.stringify(selected))
  const actual = await s.page.locator('#files').evaluate(async el => {
    const file = el.files[0]
    return { name: file.name, type: file.type, size: file.size, data: [...new Uint8Array(await file.arrayBuffer())] }
  })
  assert.equal(actual.name, 'sample.png'); assert.equal(actual.type, 'image/png'); assert.equal(actual.size, bytes.length)
  assert.deepEqual(Buffer.from(actual.data), bytes)
  assert.equal(selected.files_selected[0].sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('hidden native input is selected through an AX button; server verifies actual bytes exactly once', async t => {
  const { s, lab, put, choose } = await fixture(t)
  const content = 'unique fixture contents: 中文\n' + Math.random(), path = await put('sample.txt', content)
  const chooser_id = await choose()
  const selected = await s.run('upload', { chooser_id, files: [path] })
  assert.equal(selected.ok, true, JSON.stringify(selected))
  assert.deepEqual(selected.files_selected, [{ name: 'sample.txt', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }])
  assert.deepEqual(selected.file_choosers, [])
  assert.equal(lab.state.uploads.length, 0, 'Selection is distinct from explicit fixture submission')
  await s.run('click', { target: ref(selected, '确认上传文件') })
  assert.equal((await s.run('wait', { text: '文件上传成功', exact: true })).ok, true)
  assert.deepEqual(lab.state.uploads, [{ files: [{ name: 'sample.txt', type: 'text/plain', content }] }])
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'STALE_CHOOSER')
  assert.equal(lab.state.uploads.length, 1)
  const trace = await readFile(s.tracePath, 'utf8')
  assert.ok(!trace.includes(content)); assert.ok(!trace.includes(path))
})

test('uploads default to disabled and require explicit absolute directory configuration', async t => {
  assert.deepEqual(normalizeConfig().uploadRoots, [])
  assert.throws(() => normalizeConfig({ uploadRoots: ['relative'] }), /absolute/)
  assert.throws(() => normalizeConfig({ maxUploadBytes: 0 }), /maxUploadBytes/)
  assert.throws(() => normalizeConfig({ maxUploadFiles: 21 }), /maxUploadFiles/)
  const { s, put, choose } = await fixture(t, { uploadRoots: [] })
  const path = await put('sample.txt', 'private fixture')
  const chooser_id = await choose()
  const result = await s.run('upload', { chooser_id, files: [path] })
  assert.equal(result.error_code, 'UPLOAD_DISABLED')
  assert.equal(await s.page.locator('#files').evaluate(el => el.files.length), 0)
})

test('outside paths, traversal, file and directory symlinks cannot disclose contents', async t => {
  const { s, allowed, outside, put, choose } = await fixture(t)
  const path = await put('private.txt', 'OUTSIDE PRIVATE DATA', outside)
  await symlink(path, join(allowed, 'linked.txt'))
  await symlink(outside, join(allowed, 'linked-directory'))
  const chooser_id = await choose()
  for (const candidate of [path, allowed + '/../allowed-other/private.txt', join(allowed, 'linked.txt'), join(allowed, 'linked-directory', 'private.txt')]) {
    const result = await s.run('upload', { chooser_id, files: [candidate] })
    assert.equal(result.error_code, 'FILE_ACCESS_DENIED', JSON.stringify(result))
    assert.equal(await s.page.locator('#files').evaluate(el => el.files.length), 0)
  }
  assert.equal((await s.run('upload', { chooser_id, files: ['relative.txt'] })).error_code, 'INVALID_ARGUMENT')
  assert.ok(!(await readFile(s.tracePath, 'utf8')).includes('OUTSIDE PRIVATE DATA'))
})

test('multiple file validation is atomic; limits count combined bytes and retain empty files', async t => {
  const { s, put, choose } = await fixture(t, { maxUploadBytes: 4, maxUploadFiles: 2 })
  const a = await put('a.txt', 'abc'), b = await put('b.txt', 'de'), empty = await put('empty.txt', '')
  const chooser_id = await choose()
  assert.equal((await s.run('upload', { chooser_id, files: [a, b] })).error_code, 'UPLOAD_TOO_LARGE')
  assert.equal((await s.run('upload', { chooser_id, files: [a, empty, b] })).error_code, 'INVALID_ARGUMENT')
  assert.equal((await s.run('upload', { chooser_id, files: [a, a] })).error_code, 'UPLOAD_TOO_LARGE')
  assert.equal(await s.page.locator('#files').evaluate(el => el.files.length), 0)
  const selected = await s.run('upload', { chooser_id, files: [a, empty] })
  assert.equal(selected.ok, true, JSON.stringify(selected))
  assert.deepEqual(await s.page.locator('#files').evaluate(el => [...el.files].map(f => [f.name, f.size])), [['a.txt', 3], ['empty.txt', 0]])
})

test('single-file inputs, duplicates, directories and named pipes are rejected before selection', async t => {
  const { s, allowed, put, choose } = await fixture(t)
  const a = await put('a.txt', 'a'), b = await put('b.txt', 'b')
  await s.page.locator('#files').evaluate(el => { el.multiple = false })
  let chooser_id = await choose()
  assert.equal((await s.run('upload', { chooser_id, files: [a, b] })).error_code, 'UPLOAD_MULTIPLE_DENIED')
  await s.page.locator('#files').evaluate(el => { el.multiple = true })
  chooser_id = await choose()
  assert.equal((await s.run('upload', { chooser_id, files: [a, a] })).error_code, 'INVALID_ARGUMENT')
  const directory = join(allowed, 'directory'); await mkdir(directory)
  assert.equal((await s.run('upload', { chooser_id, files: [directory] })).error_code, 'FILE_TYPE_UNSUPPORTED')
  if (process.platform !== 'win32') {
    const fifo = join(allowed, 'pipe')
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
    assert.equal((await s.run('upload', { chooser_id, files: [fifo] })).error_code, 'FILE_TYPE_UNSUPPORTED')
  }
  assert.equal(await s.page.locator('#files').evaluate(el => el.files.length), 0)
})

test('file chooser binds original tab, node and document, and is retired by replacement or navigation', async t => {
  const { s, lab, put, choose } = await fixture(t)
  const path = await put('sample.txt', 'private fixture')
  const original = s.tabs.activeId, chooser_id = await choose()
  await s.run('tab_new', { url: lab.origin + '/uploads' })
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'WRONG_TAB')
  await s.run('tab_switch', { tab_id: original })
  await s.page.locator('#files').evaluate(el => el.replaceWith(el.cloneNode()))
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'STALE_CHOOSER')
  await s.run('open', { url: lab.origin + '/uploads' })
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'STALE_CHOOSER')
  const fresh = await choose()
  await s.run('tab_close', { tab_id: original })
  assert.equal((await s.run('upload', { chooser_id: fresh, files: [path] })).error_code, 'STALE_CHOOSER')
})

test('choosing files can auto-submit; one-shot chooser prevents repeated consequential change events', async t => {
  const { s, lab, put, choose } = await fixture(t)
  const path = await put('sample.txt', 'autosubmit fixture')
  await s.page.locator('#files').evaluate(el => { el.onchange = async () => { await fetch('/api/upload', { method: 'POST', body: JSON.stringify({ count: el.files.length }) }); document.querySelector('output').textContent = '自动上传成功' } })
  const chooser_id = await choose()
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).ok, true)
  assert.equal((await s.run('wait', { text: '自动上传成功', exact: true })).ok, true)
  assert.equal(lab.state.uploads.length, 1)
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'STALE_CHOOSER')
  assert.equal(lab.state.uploads.length, 1)
})

test('cancellation after file snapshot prevents selection and closes browser resources', async t => {
  const { s, lab, put, choose } = await fixture(t)
  const path = await put('sample.txt', 'cancelled private fixture'), chooser_id = await choose()
  const original = s.uploads.snapshot.bind(s.uploads)
  let signalSnapshot, release
  const captured = new Promise(resolve => { signalSnapshot = resolve })
  const gate = new Promise(resolve => { release = resolve })
  s.uploads.snapshot = async (...args) => { const value = await original(...args); signalSnapshot(); await gate; return value }
  const controller = new AbortController()
  const pending = s.run('upload', { chooser_id, files: [path] }, { signal: controller.signal })
  await captured; controller.abort(); release()
  assert.equal((await pending).error_code, 'ABORTED')
  assert.equal(s.browser, undefined); assert.equal(s.uploads.choosers.size, 0)
  assert.equal(lab.state.uploads.length, 0)
})

test('a configured root replaced after startup does not authorize the replacement directory', async t => {
  const { s, allowed, put, choose } = await fixture(t)
  const path = await put('sample.txt', 'original fixture'), chooser_id = await choose()
  await rename(allowed, allowed + '-original'); await mkdir(allowed)
  await writeFile(path, 'replacement private fixture')
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'FILE_ACCESS_DENIED')
  assert.equal(await s.page.locator('#files').evaluate(el => el.files.length), 0)
})

test('directory selection, disabled input and driver failures cannot leak file payloads in errors', async t => {
  const { s, put, choose } = await fixture(t)
  const content = 'PRIVATE SNAPSHOT DATA ' + Math.random(), path = await put('private.txt', content)
  const chooser_id = await choose()
  await s.page.locator('#files').evaluate(el => { el.webkitdirectory = true })
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'DIRECTORY_UPLOAD_UNSUPPORTED')
  await s.page.locator('#files').evaluate(el => { el.webkitdirectory = false; el.disabled = true })
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'TARGET_DISABLED')
  await s.page.locator('#files').evaluate(el => { el.disabled = false })
  const record = s.uploads.choosers.get(chooser_id)
  record.chooser.setFiles = async () => { throw Error('Driver failure with ' + content + ' at ' + path) }
  const failed = await s.run('upload', { chooser_id, files: [path] })
  assert.equal(failed.error_code, 'DRIVER_ERROR'); assert.equal(failed.state_uncertain, true)
  assert.ok(!JSON.stringify(failed).includes(content)); assert.ok(!JSON.stringify(failed).includes(path))
  assert.ok(!(await readFile(s.tracePath, 'utf8')).includes(content))
  assert.equal((await s.run('upload', { chooser_id, files: [path] })).error_code, 'STALE_CHOOSER')
})
