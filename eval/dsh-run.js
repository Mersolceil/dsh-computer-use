import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomBytes, randomInt } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { startLab } from './lab.js'
import { readDshEvents, dshImageEvidence } from './dsh-log.js'
import { initialMemory, foldMemory } from '../src/ledger-host.js'
import { ledgerView } from '../src/ledger.js'
import { evaluateLongContext } from './long-context-check.js'
import { summarizeRequestUsage } from './request-usage.js'
import { sourceProvenance,finishProvenance } from './provenance.js'
const source=await sourceProvenance()

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required; stored DSH credentials are not read.')
const launcher = process.env.DSH_LAUNCHER || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const root = resolve('.artifacts/dsh-eval', new Date().toISOString().replaceAll(':', '-'))
await mkdir(root, { recursive: true })
const sanitize = value => value.replaceAll(process.env.DEEPSEEK_API_KEY, '[REDACTED]')
const selected = process.argv.includes('--scenario') ? process.argv[process.argv.indexOf('--scenario') + 1] : undefined
const toolsMode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : 'native'
if (!['native','ptc'].includes(toolsMode)) throw new Error('--mode must be native or ptc')
const variant=process.argv.includes('--variant')?process.argv[process.argv.indexOf('--variant')+1]:'baseline'
if(!['baseline','witness'].includes(variant))throw Error('--variant must be baseline or witness')
const scenarios = (selected==='long-context'?['long-context']:['workflow', 'accessibility', 'multi-tab', 'history', 'file-upload', 'vision', 'visual-click', 'cancel', 'context-history', 'ledger'].filter(s => !selected || s === selected))
if (!scenarios.length) throw new Error('Unknown --scenario')
const results = []
for (const scenario of scenarios) {
  const dir = join(root, scenario)
  await mkdir(dir, { recursive: true })
  const uploadDir = join(dir, 'upload-inputs'), uploadPath = join(uploadDir, 'dsh-fixture.txt')
  const uploadContent = 'Fresh DSH fixture: ' + randomBytes(24).toString('hex') + '\n中文'
  if (scenario === 'file-upload') { await mkdir(uploadDir); await writeFile(uploadPath, uploadContent) }
  const visionCode = randomBytes(3).toString('hex').toUpperCase()
  const tabCode=randomBytes(3).toString('hex').toUpperCase()
  const lab = await startLab({ port: 0, visionCode,tabCode, visualTarget: {x:randomInt(150,651),y:randomInt(70,201)} })
  const traceDir = join(dir, 'browser-traces')
  const overlay = join(dir, 'overlay.yml')
  const longConfig=scenario==='long-context'?`        historyKeepRecent: 4\n        ptcHistoryEnabled: true\n        ptcCompactDuplicatesEnabled: ${variant==='witness'}\n        taskStateEnabled: true\n        imagePinsEnabled: true\n        imageWindowEnabled: true\n        imageWindowKeep: 2\n        budgetStatusEnabled: true\n`:''
  await writeFile(overlay, `- id: tools\n  config:\n    mode: ${toolsMode}\n- id: session-title-llm\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- insert:\n    - id: cu-live-plugin\n      name: ${JSON.stringify(resolve('src/plugin.js'))}\n      config:\n        headless: true\n        allowedOrigins: [${JSON.stringify(lab.origin)}]\n        artifactDir: ${JSON.stringify(traceDir)}\n${longConfig}        maxSteps: ${scenario==='long-context'?120:50}\n    - id: cu-live-policy\n      name: ${JSON.stringify(resolve('eval/dsh-policy.js'))}\n`)
  if (scenario === 'file-upload') await writeFile(overlay, (await readFile(overlay, 'utf8')).replace('        maxSteps: 50', `        uploadRoots: [${JSON.stringify(uploadDir)}]\n        maxSteps: 50`))
  const prompts = {
    'long-context': `只用 cu_browser 工具完成长流程验收，绝不使用网页脚本、终端或其他工具。先调用 note 记录 decision“初始方案：直接保存”，再用 memory 找到已提交 ID，以 supersedes 纠正为“最终方案：先核对再保存一次”。访问 ${lab.origin.replace('127.0.0.1','localhost')} 触发来源拒绝，记住实际错误；打开 ${lab.origin}/tab-detail，用 observe(filter=all) 读取随机六位核对码。截取第一张图，然后至少进行 10 次单独的 observe；每次结果都要实际取得。用 cu_browser_history_index(action="cu_browser_screenshot") 查询实际已记录截图，第一张截图的 source_event_seq 用 image_pin 固定并用 image_pins 确认；不能使用 PTC dispatch 编号。索引为空时报告缺失，不猜编号。接着打开 ${lab.origin}，至少进行另外 40 次单独的 observe，过程中至少分四次改变标题文本并分别截图，以产生不同图像；每次观察必须独立调用。每隔 10 次观察重新检查历史与当前进度，不要重复保存。先用 cu_browser_history_index(action="cu_browser_observe") 分页找到最初明细观察，再用 cu_browser_recall 回查并确认随机核对码；用 image_window_status 检查窗口，用 image_recall 重新读取一张已卸载的旧截图（不是固定截图），事件序号必须通过 cu_browser_history_index 查询并结合窗口状态确定；不能猜编号。用 note 记录 stage“准备保存一次”并确认提交。最后把随机核对码作为标题、描述写“长流程验收”，恰好保存一次并确认。报告随机码、实际最初错误代码和“最终方案”，然后关闭浏览器。`,
    ledger: `仅用 cu_browser 工具验收事实账本。先调用 note 记一条 decision："初步判断：首次安装必须重启"，再用 memory 读取已提交的实际 ID；然后用 note 的 supersedes 纠正为"纠正：首次安装可即时启用，升级失败时冷启动恢复"，不得猜 ID。接着尝试 open ${lab.origin.replace('127.0.0.1','localhost')}（这是专门测试精确来源拒绝，不要绕过限制）；用 memory 查找实际 ORIGIN_DENIED 错误记录及其 evidence 事件序号，用 note 记 stage："先检查结果，不重复提交"并引用该序号。随后打开允许的 ${lab.origin}，填写标题"账本验收"、描述"只有一次提交"，只保存一次、检查真实保存状态、截图、再读 memory。最终报告原始错误代码和最新纠正的决定，不能把已撤回的判断作为当前结论，也不能将 note 的 accepted 当作 verified。最后关闭浏览器。`,
    'context-history': `仅用 cu_browser 工具。先打开 ${lab.origin}/tab-detail，用 observe(filter=all) 读取本轮核对码。随后依次用 open 访问 ${lab.origin}/history-a、${lab.origin}/history-b、${lab.origin}/history-a、${lab.origin}/history-b、${lab.origin}/history-a，共五次导航均要执行。然后必须调用 cu_browser_recall，用历史结果中明确提供的 history.source_event_seq 回查最初明细的原始观察，不猜事件号。最后打开 ${lab.origin}，以回查到的六位核对码作为任务标题、描述为“历史回查验收”，只保存一次，确认保存成功，截图，关闭浏览器。不要使用终端或网页代码。`,
    workflow: `只使用 cu_browser 工具操作本地练习台 ${lab.origin}。依次：搜索“浏览器”并读取结果；创建任务，标题“DSH原生验收”，描述“验证完整工具链”，只保存一次；打开遮挡弹窗，关闭弹窗后点击目标按钮，确认成功。每一步用最新 ref。最后关闭浏览器并简短报告。不要使用其他工具。`,
    accessibility: `只使用 cu_browser 工具打开 ${lab.origin}/advanced，优先读取无障碍树。填写收货信息：收件人“李明”、城市“北京”、同意条款、加急配送，只保存一次并确认。随后填写 iframe 中的嵌入地址“上海市测试路”并保存；再填写影子输入“shadow内容”并保存。分别核对结果，最后关闭浏览器。不要执行代码或使用其他工具。`,
    'multi-tab': `只使用 cu_browser 工具打开 ${lab.origin}/tabs。点击“打开订单明细”链接，保留真实弹出的标签页，在明细中读取本轮核对码。回到原工作台填写核对码，只保存一次，确认成功。然后仅关闭明细页，确认工作台仍在且只剩一个标签页；最后关闭整个浏览器。优先 AX 树，必要时 find 或 filter=all 读取正文。不要读取网页源码或执行网页代码。`,
    history: `只使用 cu_browser 工具打开 ${lab.origin}/history-a。点击“打开页面乙”，确认标题，然后后退到甲、前进到乙、再后退到甲，最后刷新一次甲。每一步确认返回的标题；保持同一个标签页，操作完毕后关闭浏览器。不要使用其他工具或网页代码。`,
    'file-upload': `只使用 cu_browser 工具打开 ${lab.origin}/uploads。点击“选择待上传文件”，将本地文件 ${uploadPath} 通过返回的 file_choosers 请求选入网页。该文件处于已配置的专用上传目录内。随后点击“确认上传文件”，只提交一次，确认“文件上传成功”，最后关闭浏览器。不要用其他工具读取文件，也不要执行网页代码。`,
    vision: `只使用 cu_browser 工具打开 ${lab.origin}/vision。调用 screenshot 查看图片，读取画布中的六位代码，最后完整回答该代码。不要读取网页源代码，不要使用其他工具；这次画布文字不会出现在结构化文本里。读完后关闭浏览器。`,
    'visual-click': `只使用 cu_browser 工具打开 ${lab.origin}/visual-click。无障碍树无法定位画布内部图形，这次必须用 screenshot 查看实际图片，使用该截图的 screenshot_id 和图片坐标，通过 pixel_click 点击绿色 CONFIRM 区域的中心一次。区域每次随机移动，不能根据文字猜坐标；不要点击灰色 CANCEL。观察状态，必要时等待“视觉确认成功”，确认只提交一次，然后关闭浏览器并报告。禁止读取源码或执行其他工具。`,
    cancel: `使用 cu_browser 工具打开 ${lab.origin}，搜索“浏览器”，随后填写任务并保存。每一步都使用最新 ref，最后关闭浏览器。`,
  }
  let stdout = '', stderr = '', timedOut = false
  const start = performance.now()
  const prompt=toolsMode==='ptc' ? prompts[scenario].replace('不要执行代码或使用其他工具。','不要执行网页代码或使用其他工具。')+' 当前使用 PTC 模式：通过 run_code 按顺序 await tools.cu_browser_* 调用这些工具，返回 accessibility_tree、file_choosers 和 visual_context 作为主要观察；不要额外执行网页代码。图片由 DSH 在程序结束后附带，所以截图和看图点击须分成不同轮次。'+(scenario==='long-context'?' 每次 observe 必须单独运行一个 run_code 并结束该程序，再开始下一次；不得在同一个 run_code 里合并观察。每次 run_code 只调用一个工具并完整返回其结果，例如 const result = await tools.cu_browser_observe({}); return result; 不要只提取 accessibility_tree、打印摘要或修改结果字段，否则无法保留该结果的历史。事件编号只能从 cu_browser_history_index 读取；找不到时明确报告，禁止枚举猜测编号。':'') : prompts[scenario]
  const child = spawn(launcher, ['headless', '--patch', overlay, '--json', prompt], {
    cwd: resolve('.'), env: { ...process.env, DSH_HOME: join(dir, 'home'), DSH_TOOLS_MODE: toolsMode, CU_DSH_EVAL_MODE: toolsMode, CU_DSH_CANCEL: scenario === 'cancel' ? '1' : '0', CU_DSH_LONG_FLOW:scenario==='long-context'?'1':'0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGINT'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }, scenario==='long-context'?900000:180000)
  let exit
  try { exit = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject) }) }
  finally { clearTimeout(timer) }
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  await writeFile(join(dir, 'events.jsonl'), sanitize(stdout))
  await writeFile(join(dir, 'stderr.txt'), sanitize(stderr))
  const traces = []
  for (const file of await readdir(traceDir).catch(() => [])) {
    const raw = await readFile(join(traceDir, file), 'utf8')
    traces.push(...raw.trim().split('\n').filter(Boolean).map(JSON.parse))
  }
  const observations = traces.filter(t => t.type === 'observation').map(t => t.value)
  const final = events.filter(e => e.type === 'final').at(-1)
  const answer = typeof final?.text === 'string' ? final.text : typeof final?.answer === 'string' ? final.answer : JSON.stringify(final || {})
  const toolEvents = events.filter(e => e.type === 'tool_call')
  const toolResults = events.filter(e => e.type === 'tool_result')
  // The CLI's human-facing tool_result projection is text-only. Verify images
  // against authoritative durable tool results, not this lossy projection.
  const durable = await readDshEvents(join(dir, 'home/sessions'))
  const imageEvidence=dshImageEvidence(durable)
  const foundImage = imageEvidence.delivered_image_blocks > 0
  const browserCalls=durable.filter(e=>['tool/call','tool/ptc-dispatch-start'].includes(e.type)&&e.data?.name?.startsWith('cu_browser_'))
  const aborted = durable.some(e => e.type === 'turn/end' && e.data?.reason?.kind === 'aborted')
  const usage = events.filter(e => e.type === 'status' && e.usage).reduce((sum, e) => {
    for (const [key, value] of Object.entries(e.usage)) if (typeof value === 'number') sum[key] = (sum[key] || 0) + value
    return sum
  }, {})
  let success
  let ledgerEvidence
  let longEvidence
  if(scenario==='long-context'){longEvidence=evaluateLongContext({events:durable,server:lab.state,answer,code:tabCode,exitCode:exit,timedOut});success=longEvidence.success}
  if(scenario==='ledger'){let memory=initialMemory();for(const event of durable)memory=foldMemory(memory,event);const view=ledgerView(memory.ledger);ledgerEvidence={entries:memory.ledger.entries,active_decisions:view.active.filter(e=>e.kind==='decision'),receipts:memory.receipts.filter(r=>r.status!=='observed')};const error=memory.ledger.entries.find(e=>e.kind==='error'&&e.text.includes('ORIGIN_DENIED'));success=exit===0&&lab.state.submissions===1&&lab.state.last?.title==='账本验收'&&lab.state.last?.description==='只有一次提交'&&foundImage&&ledgerEvidence.active_decisions.length===1&&ledgerEvidence.active_decisions[0].text.includes('首次安装可即时启用')&&memory.ledger.entries.filter(e=>e.kind==='decision').length===2&&memory.ledger.entries.filter(e=>e.source==='agent').every(e=>e.verified===false)&&!!error&&memory.ledger.entries.some(e=>e.kind==='stage'&&e.evidence.some(seq=>error.evidence.includes(seq)))&&answer.includes('ORIGIN_DENIED')}
  if (scenario === 'context-history') success = exit === 0 && lab.state.submissions === 1 && lab.state.last?.title === tabCode && lab.state.last?.description === '历史回查验收' && durable.filter(e=>e.type==='compaction/prune').length >= 2 && durable.some(e=>e.type==='tool/result' && e.data?.message?.content?.some(b=>b.type==='text' && b.text.includes('content_text') && b.text.includes(tabCode))) && browserCalls.some(e=>e.data.name==='cu_browser_recall') && foundImage
  if (scenario === 'workflow') success = exit === 0 && lab.state.submissions === 1 && lab.state.last?.title === 'DSH原生验收' && lab.state.last?.description === '验证完整工具链' && observations.some(o => o.text.includes('浏览器自动化入门：Playwright')) && observations.some(o => o.text.includes('已点击目标按钮'))
  if (scenario === 'accessibility') success = exit === 0 && lab.state.submissions===1 && lab.state.last?.recipient==='李明' && lab.state.last?.city==='bj' && lab.state.last?.agreed===true && lab.state.last?.delivery==='express' && observations.some(o=>o.text.includes('嵌入保存成功：上海市测试路')) && observations.some(o=>o.text.includes('影子内容：shadow内容'))
  if (scenario === 'multi-tab') success = exit===0 && lab.state.submissions===1 && lab.state.last?.kind==='tab-check' && lab.state.last.code===tabCode && observations.some(o=>o.tabs?.some(t=>t.opener_tab_id)) && observations.at(-1)?.tabs.length===1 && observations.at(-1)?.url.endsWith('/tabs') && observations.some(o=>o.text.includes('核对已保存：'+tabCode))
  if (scenario === 'history') success = exit===0 && observations.at(-1)?.url.endsWith('/history-a') && traces.filter(t=>t.type==='navigation').sort((a,b)=>a.navigation_sequence-b.navigation_sequence).map(t=>new URL(t.url).pathname).join('|').includes('/history-b|/history-a|/history-b|/history-a|/history-a')
  if (scenario === 'file-upload') success = exit === 0 && lab.state.uploads.length === 1 && lab.state.uploads[0].files.length === 1 && lab.state.uploads[0].files[0].name === 'dsh-fixture.txt' && lab.state.uploads[0].files[0].content === uploadContent && observations.some(o => o.text.includes('文件上传成功')) && browserCalls.filter(e => e.data.name === 'cu_browser_upload').length === 1
  if (scenario === 'vision') success = exit === 0 && answer.includes(visionCode) && foundImage && observations.every(o => !o.text.includes(visionCode) && !o.elements.some(e => e.name.includes(visionCode) || e.value.includes(visionCode)))
  if (scenario === 'visual-click') success = exit === 0 && foundImage && lab.state.submissions===1 && lab.state.last?.kind==='visual-confirm' && observations.some(o=>o.text.includes('视觉确认成功')) && browserCalls.some(e=>e.data.name==='cu_browser_pixel_click')
  if (scenario === 'cancel') success = !timedOut && exit !== 0 && aborted && lab.state.submissions === 0 && traces.some(t => t.type === 'session_closed' && t.reason === 'agent-aborted')
  const result = { scenario, ...(ledgerEvidence?{ledger_evidence:ledgerEvidence}:{}), ...(longEvidence?{long_evidence:longEvidence,variant}:{}), success: Boolean(success), exit_code: exit, timed_out: timedOut, elapsed_ms: Math.round(performance.now() - start), tool_calls: toolEvents.length,
    browsers:traces.filter(t=>t.type==='browser_started').map(({version,runtime})=>({version,runtime})),
    final_answer: sanitize(answer), ...(scenario === 'vision' ? { expected_code: visionCode, actual_image_in_model_context: foundImage } : {}),
    ...imageEvidence,browser_tool_calls:browserCalls.length,durable_turn_aborted: aborted, usage,request_usage:summarizeRequestUsage(events),
    server_submissions: lab.state.submissions, server_uploads: lab.state.uploads.length, trace_files: (await readdir(traceDir).catch(() => [])).length, directory: dir }
  results.push(result)
  await lab.close()
  console.log(`${result.success ? 'PASS' : 'FAIL'} DSH ${toolsMode} ${scenario} exit=${exit} tools=${toolEvents.length} ms=${result.elapsed_ms}`)
  if (!result.success) console.log(`Inspect: ${join(dir, 'stderr.txt')}`)
}
const configuredEndpoint = process.env.DEEPSEEK_BASE_URL
let endpointKind = configuredEndpoint ? 'custom' : 'default'
try { if (configuredEndpoint && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(configuredEndpoint).hostname)) endpointKind = 'loopback' } catch { endpointKind = 'invalid' }
const report = { date: new Date().toISOString(),provenance:await finishProvenance(source), mode: 'real-installed-dsh-headless', tools_mode:toolsMode, model: 'deepseek-flash', configured_endpoint_kind: endpointKind, passed: results.filter(r => r.success).length, total: results.length,
  note: 'Actual DSH headless profile, agent loop, model adapter, tool registry, session persistence and attachment store; not the Desktop graphical UI. Endpoint kind reflects the environment override only, not independent proof of the effective endpoint or model.', results }
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
console.log(`Report: ${join(root, 'report.json')}`)
if (report.passed !== report.total || !report.provenance.source_unchanged) process.exitCode = 1
