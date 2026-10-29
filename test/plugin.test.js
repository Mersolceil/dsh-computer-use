import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, renderResult } from '../src/plugin.js'
import { startLab } from '../eval/lab.js'

async function plugin(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cu-plugin-'))
  const lab = await startLab({ port: 0 })
  const defs = new Map()
  const disposers = []
  const listeners = new Map()
  let imageBytes
  const ctx = {
    tools: { register(def) { assert.ok(def.output.schema); defs.set(def.name, def); return () => defs.delete(def.name) } },
    attachments: { async saveImages(images) { imageBytes = images[0].data; return [{ attachmentId: 'sha256:test', mediaType: 'image/png', width: 1280, height: 720, bytes: imageBytes.length }] } },
    on(event, fn) { listeners.set(event, fn); if (event === 'dispose') disposers.push(fn) },
  }
  apply(ctx, { headless: true, allowedOrigins: [lab.origin], artifactDir: dir })
  const agent = { session: {} }
  const run = (action, args = {}, who = agent, signal = new AbortController().signal) => defs.get(`cu_browser_${action}`).execute(args, { agent: who, signal })
  t.after(async () => { for (const dispose of disposers) await dispose(); await lab.close(); await rm(dir, { recursive: true, force: true }) })
  return { defs, run, lab, disposers, agent, listeners, image: () => imageBytes }
}

test('native adapter registers browser tools and uses the DSH attachment format', async t => {
  const p = await plugin(t)
  for (const action of ['open', 'observe', 'find', 'click', 'fill', 'check', 'select', 'wait', 'hover', 'screenshot', 'close']) assert.ok(p.defs.has(`cu_browser_${action}`))
  await p.run('open', { url: p.lab.origin })
  const value = await p.run('screenshot')
  assert.equal(p.image().subarray(1, 4).toString(), 'PNG')
  assert.ok(!value.screenshot)
  const content = renderResult({}, value)
  assert.equal(content[1].type, 'image')
  assert.equal(content[1].attachment.attachmentId, 'sha256:test')
  assert.ok(!content[0].text.includes('iVBOR'))
})

test('a different agent cannot inspect, close or navigate the owner session', async t => {
  const p = await plugin(t)
  await p.run('open', { url: p.lab.origin })
  for (const action of ['observe', 'close', 'open']) await assert.rejects(p.run(action, action === 'open' ? { url: p.lab.origin } : {}, {}), /BROWSER_OWNED/)
  for (const [action,args] of [['tabs',{}],['tab_new',{url:p.lab.origin}],['tab_switch',{tab_id:'t1'}],['tab_close',{tab_id:'t1'}],['history',{direction:'back'}]]) await assert.rejects(p.run(action,args,{}),/BROWSER_OWNED/)
  await assert.rejects(p.run('upload', { chooser_id: 'not-issued', files: ['/tmp/not-read.txt'] }, {}), /BROWSER_OWNED/)
  await p.run('close')
  assert.equal((await p.run('open', { url: p.lab.origin }, {})).ok, true)
})

test('argument validation rejects unknown properties and missing fields', async t => {
  const p = await plugin(t)
  await assert.rejects(p.run('open', { url: p.lab.origin, evaluate: 'code' }), /Unknown argument/)
  await assert.rejects(p.run('fill', { target: 'x' }), /text must be a string/)
})

test('plugin disposal unregisters tools and closes the active browser', async t => {
  const p = await plugin(t)
  await p.run('open', { url: p.lab.origin })
  const old = p.defs.get('cu_browser_observe')
  for (const dispose of p.disposers) await dispose()
  assert.equal(p.defs.size, 0)
  await assert.rejects(old.execute({}, { agent: {}, signal: new AbortController().signal }), /disposed/)
})

test('cancelling between calls retires the existing browser and releases its owner', async t => {
  const p = await plugin(t)
  const opened = await p.run('open', { url: p.lab.origin })
  p.listeners.get('session/event')(p.agent.session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  // Retirement is an async notification; wait for the recorded completion.
  const { readFile } = await import('node:fs/promises')
  for (let i = 0; i < 100; i++) {
    if ((await readFile(opened.trace_path, 'utf8')).includes('agent-aborted')) break
    await new Promise(r => setTimeout(r, 10))
  }
  assert.match(await readFile(opened.trace_path, 'utf8'), /agent-aborted/)
  assert.equal((await p.run('open', { url: p.lab.origin }, { session: {} })).ok, true)
})

test('agent disposal closes a browser even when no tool is currently running', async t => {
  const p = await plugin(t)
  await p.run('open', { url: p.lab.origin })
  await p.listeners.get('agent/disposed')({ agent: p.agent })
  assert.equal((await p.run('open', { url: p.lab.origin }, { session: {} })).ok, true)
})
