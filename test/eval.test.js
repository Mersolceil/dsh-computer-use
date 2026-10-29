import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { decodeDshLog } from '../eval/dsh-log.js'

test('native DSH log reader sees image blocks beyond the first zstd frame', () => {
  const first = { type: 'session' }
  const second = { type: 'tool/result', data: { message: { content: [{ type: 'image', attachment: { attachmentId: 'sha256:test' } }] } } }
  const bytes = Buffer.concat([zstdCompressSync(JSON.stringify(first) + '\n'), zstdCompressSync(JSON.stringify(second) + '\n')])
  assert.deepEqual(decodeDshLog(bytes), [first, second])
})

for(const [suite,expected] of [['core',5],['workflows',2],['files',1]])test(`model evaluation rejects fabricated success in ${suite}`, { timeout: 40000 }, async t => {
  // A local API fixture claims success without doing anything. All
  // episodes must fail; the model's final prose cannot award itself a pass.
  let requests = 0
  const api = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(body.parallel_tool_calls, false)
    assert.ok(body.tools.every(t => t.function.name.startsWith('cu_browser_')))
    requests++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '任务已全部完成。' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }))
  })
  await new Promise(r => api.listen(0, '127.0.0.1', r))
  const dir = await mkdtemp(join(tmpdir(), 'cu-eval-'))
  await mkdir(join(dir, '.artifacts'))
  t.after(async () => { await new Promise(r => api.close(r)); await rm(dir, { recursive: true, force: true }) })
  const child = spawn(process.execPath, [resolve('eval/run.js'), '--model', 'fixture','--suite',suite], { cwd: dir,
    env: { ...process.env, DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${api.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  assert.equal(exit, 1, output)
  assert.equal(requests, expected, output)
  const reports = await readdir(join(dir, '.artifacts/eval'))
  const report = JSON.parse(await readFile(join(dir, '.artifacts/eval', reports[0], 'report.json')))
  assert.equal(report.passed, 0)
  assert.equal(report.model, 'fixture')
  assert.ok(report.results.every(r => r.answer === '任务已全部完成。' && r.input_tokens === 10))
})
