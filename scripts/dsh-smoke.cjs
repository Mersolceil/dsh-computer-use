// Run with the installed DSH Electron runtime (ELECTRON_RUN_AS_NODE=1).
// This checks the real Cordis + dsh-tools pipeline without changing any profile
// or making a model request. Attachment storage is a fixture in this check.
const { pathToFileURL } = require('node:url')
const { resolve, join } = require('node:path')
const { mkdtemp, rm, mkdir, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

;(async () => {
  const root = process.env.DSH_MODULES || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/'
  const { Context, Service } = await import(pathToFileURL(join(root, '@deepseek-ai/cordis/lib/index.js')).href)
  const { ToolRuntime } = await import(pathToFileURL(join(root, '@deepseek-ai/dsh-tools/lib/index.js')).href)
  const pluginPath=process.env.CU_PLUGIN_PATH || resolve('src/plugin.js')
  const plugin = await import(pathToFileURL(pluginPath).href)
  const { startLab } = await import(pathToFileURL(resolve('eval/lab.js')).href)
  const dir = await mkdtemp(join(tmpdir(), 'cu-dsh-smoke-'))
  const uploadDir = join(dir, 'upload-inputs')
  await mkdir(uploadDir)
  const uploadPath = join(uploadDir, 'dsh-fixture.txt'), uploadContent = 'DSH temporary upload fixture: 中文'
  await writeFile(uploadPath, uploadContent)
  const lab = await startLab({ port: 0 })
  const ctx = new Context()
  class PromptFixture extends Service {
    constructor(c) { super(c, 'systemPrompt') }
    tools() { return () => {} }
  }
  class AttachmentFixture extends Service {
    constructor(c) { super(c, 'attachments') }
    async saveImages(inputs) {
      return inputs.map(i => ({ attachmentId: 'sha256:' + createHash('sha256').update(i.data).digest('hex'), mediaType: i.mediaType, width: 1280, height: 720, bytes: i.data.length }))
    }
  }
  new PromptFixture(ctx)
  new AttachmentFixture(ctx)
  const runtime = new ToolRuntime(ctx, { mode: 'native' })
  const fiber = ctx.plugin(plugin, { headless: true, allowedOrigins: [lab.origin], artifactDir: dir, uploadRoots: [uploadDir] })
  await fiber
  const agent = {}
  let index = 0
  const invoke = (action, args = {}, who = agent) => runtime.execute({ callId: `smoke-${++index}`, name: `cu_browser_${action}`, arguments: args, agent: who, signal: new AbortController().signal })
  const checks = []
  const check = (name, condition) => { assert.ok(condition, name); checks.push({ name, passed: true }) }
  try {
    check('browser tools registered in real DSH runtime', runtime.schemas().filter(t => t.name.startsWith('cu_browser_')).length === plugin.toolSpecifications.length)
    const opened = await invoke('open', { url: lab.origin })
    check('real pipeline opens browser', !opened.isError && opened.value.ok)
    const target = opened.value.elements.find(e => e.name === '关键词').ref
    const filled = await invoke('fill', { target, text: '浏览器' })
    check('canonical output survives DSH schema validation', !filled.isError && filled.value.elements.some(e => e.value === '浏览器'))
    const denied = await invoke('observe', {}, {})
    check('cross-agent access is a DSH error', denied.isError && denied.content.some(b => b.text?.includes('BROWSER_OWNED')))
    const image = await invoke('screenshot')
    check('image content survives DSH tool rendering', !image.isError && image.content.some(b => b.type === 'image' && b.attachment.attachmentId.startsWith('sha256:')))
    const invalid = await invoke('fill', { target })
    check('invalid arguments are a DSH error', invalid.isError)
    const uploadPage = await invoke('open', { url: lab.origin + '/uploads' })
    const chooseRef = uploadPage.value.elements.find(e => e.name === '选择待上传文件').ref
    const chooser = await invoke('click', { target: chooseRef })
    const chooser_id = chooser.value.file_choosers[0].chooser_id
    const deniedFile = await invoke('upload', { chooser_id, files: [join(dir, 'outside.txt')] })
    check('upload directory policy survives real DSH tool execution', !deniedFile.isError && deniedFile.value.error_code === 'FILE_ACCESS_DENIED')
    const selected = await invoke('upload', { chooser_id, files: [uploadPath] })
    check('actual DSH pipeline selects allowed file bytes', !selected.isError && selected.value.ok && selected.value.files_selected[0].bytes === Buffer.byteLength(uploadContent))
    await invoke('click', { target: selected.value.elements.find(e => e.name === '确认上传文件').ref })
    await invoke('wait', { text: '文件上传成功', exact: true })
    check('server receives original DSH fixture exactly once', lab.state.uploads.length === 1 && lab.state.uploads[0].files[0].content === uploadContent)
    const closed = await invoke('close')
    check('browser closes through DSH execution', !closed.isError && closed.value.closed)
  } finally {
    await fiber.dispose()
    await lab.close()
    await rm(dir, { recursive: true, force: true })
  }
  check('fiber disposal unregisters all browser tools', runtime.schemas().every(t => !t.name.startsWith('cu_browser_')))
  const report = { date: new Date().toISOString(),runtime: root,plugin_path:pluginPath, checks, model_calls: 0, note: 'Real installed Cordis + dsh-tools; prompt and attachment storage fixtures; no Desktop UI session.' }
  await mkdir('.artifacts', { recursive: true })
  await writeFile('.artifacts/dsh-smoke.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
