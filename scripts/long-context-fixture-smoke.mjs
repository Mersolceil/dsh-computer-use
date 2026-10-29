// Exercise the real DSH evaluation harness with a local, intentionally dishonest
// Messages provider. This is a negative test, not a model capability evaluation.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import assert from 'node:assert/strict'

const sentinel = 'FIXTURE_CLAIMS_SUCCESS ORIGIN_DENIED 最终方案'
const imageProbe = process.argv.includes('--image-window')
const indexProbe = process.argv.includes('--history-index')
let requests = 0
let uploads = 0
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  if (req.url?.endsWith('/files') && req.method === 'POST') {
    uploads++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: `fixture-file-${uploads}`, type: 'file', mime_type: 'image/png', size_bytes: Buffer.byteLength(body), created_at: new Date().toISOString(), filename: 'fixture.png' }))
    return
  }
  requests++
  const origin = body.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
  const payload=JSON.parse(body)
  const values=(payload.messages??[]).flatMap(m=>(Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result').flatMap(b=>{try{return[JSON.parse(typeof b.content==='string'?b.content:b.content?.find(x=>x.type==='text')?.text)]}catch{return[]}}))
  const indexed=values.find(v=>Array.isArray(v.entries)&&v.entries.some(e=>e.action==='cu_browser_observe'))
  const calls = [
    ['cu_browser_open', { url: origin }],
    ['cu_browser_screenshot', {}], ['cu_browser_screenshot', {}], ['cu_browser_screenshot', {}],
    ['cu_browser_image_window_status', {}], ['cu_browser_image_window_status', {}], ['cu_browser_close', {}],
  ]
  const indexCalls=[['cu_browser_open',{url:origin+'/tab-detail'}],['cu_browser_observe',{filter:'all'}],['cu_browser_open',{url:origin+'/history-a'}],['cu_browser_open',{url:origin+'/history-b'}],['cu_browser_open',{url:origin+'/history-a'}],['cu_browser_history_index',{action:'cu_browser_observe'}],['cu_browser_recall',{event_seq:indexed?.entries[0]?.source_event_seq,max_chars:16000}],['cu_browser_close',{}]]
  const call = indexProbe?indexCalls[requests-1]:imageProbe ? calls[requests - 1] : undefined
  if (call?.[0] === 'cu_browser_open' && !origin) throw new Error('fixture prompt lacks loopback origin')
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 123, output_tokens: 0 } } },
    call ? { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `fixture-${requests}`, name: call[0], input: call[1] } } : { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...(!call ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: sentinel } }] : []),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
try {
  const child = spawn(process.execPath, ['eval/dsh-run.js', '--scenario', 'long-context', '--mode', 'native'], {
    env: { ...process.env, DEEPSEEK_API_KEY: 'local-fixture-only', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120000)
  const [exit] = await once(child, 'close')
  clearTimeout(timeout)
  const path = output.match(/^Report: (.+)$/m)?.[1]
  assert.ok(path, `evaluation did not write a report; exit=${exit}; ${errors.slice(-1500)}`)
  const report = JSON.parse(await readFile(path, 'utf8'))
  const result = report.results[0]
  assert.ok(requests > 0, 'local fixture provider was not contacted')
  assert.equal(result.exit_code, 0, 'DSH did not finish its provider response successfully')
  assert.ok(result.final_answer.includes(sentinel), 'DSH final answer did not contain the fixture response')
  assert.equal(exit, 1, 'fabricated final answer must fail the evaluation')
  assert.equal(result.success, false)
  assert.equal(result.server_submissions, 0)
  if(indexProbe){
    assert.equal(result.browser_tool_calls,8)
    const rows=(await readFile(`${result.directory}/events.jsonl`,'utf8')).split('\n').flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}})
    const outcome=id=>JSON.parse(rows.find(e=>e.type==='tool_result'&&e.callId===id)?.result??'null')
    const index=outcome('fixture-6'),recalled=outcome('fixture-7')
    assert.equal(index?.ok,true);assert.equal(index.entries.length,1)
    assert.equal(recalled?.ok,true);assert.equal(recalled.source_event_seq,index.entries[0].source_event_seq)
    const original=JSON.parse(recalled.content_text)
    assert.ok(original.url.endsWith('/tab-detail'));assert.match(original.accessibility_tree,/[A-F0-9]{6}/)
    console.log('History index issued the actual archived ID; DSH recalled the original detail observation.')
  } else if (!imageProbe) assert.equal(result.browser_tool_calls, 0)
  else {
    assert.equal(result.browser_tool_calls, 7, 'all scripted browser calls must reach DSH')
    const events = await readFile(`${result.directory}/events.jsonl`, 'utf8')
    const rows = events.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    const status = id => JSON.parse(rows.find(e => e.type === 'tool_result' && e.callId === id)?.result ?? 'null')
    assert.equal(status('fixture-5')?.status, 'pending_input_deferred', 'reminder input should defer the window')
    assert.equal(status('fixture-6')?.status, 'offloaded', 'window should resume after the reminder')
    assert.equal(status('fixture-6')?.offloaded, 1)
    assert.ok(result.long_evidence.image_offload_events >= 1, 'host must persist the offload event')
    console.log('Image window deferred for reminder, then offloaded one image in actual DSH.')
  }
  assert.equal(result.long_evidence.success, false)
  console.log(JSON.stringify({ ok: true, fixture_requests: requests, evaluator_rejected_fabrication: true, provider_usage: result.request_usage, report: path }, null, 2))
} finally {
  await new Promise(resolve => server.close(resolve))
}
