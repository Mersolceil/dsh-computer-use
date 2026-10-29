import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserSession } from '../src/browser.js'
import { modelObservation } from '../src/accessibility.js'
import { startLab } from '../eval/lab.js'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cu-ax-'))
  const lab = await startLab({ port: 0 })
  const s = new BrowserSession({ headless: true, allowedOrigins: [lab.origin], artifactDir: directory, ...options })
  t.after(async () => { await s.shutdown(); await lab.close(); await rm(directory, { recursive: true, force: true }) })
  const first = await s.run('open', { url: lab.origin + '/advanced' })
  assert.equal(first.ok, true, JSON.stringify(first))
  return { s, lab, first }
}
const ref = (value, name) => {
  assert.equal(value.ok, true, JSON.stringify(value))
  const element = value.elements.find(e => e.name === name)
  assert.ok(element, `Missing accessible name: ${name}`)
  return element.ref
}

test('official ARIA names, hierarchy and states replace guessed HTML labels', async t => {
  const {first} = await fixture(t)
  assert.equal(first.observation_source, 'playwright-aria-snapshot')
  assert.match(first.accessibility_tree, /main "语义验收"/)
  assert.match(first.accessibility_tree, /form "收货信息"/)
  assert.ok(first.elements.some(e=>e.name==='真实 可访问名称'))
  assert.ok(!first.elements.some(e=>e.name==='视觉图标'))
  assert.equal(first.elements.find(e=>e.name==='不可操作').disabled,true)
  assert.match(first.accessibility_tree, /tab "待处理".*\[selected=true\]/)
})

test('references survive unrelated actions and DOM reordering', async t => {
  const {s,first} = await fixture(t)
  const old=ref(first,'稳定目标')
  let v=await s.run('click',{target:ref(first,'重排目标')})
  assert.equal(ref(v,'稳定目标'),old)
  v=await s.run('click',{target:old})
  assert.equal(v.ok,true)
  assert.match(v.text,/稳定目标已点击/)
})

test('role/name changes retire a reference even if the DOM node is reused', async t => {
  const {s,first} = await fixture(t)
  const old=ref(first,'稳定目标')
  await s.run('click',{target:ref(first,'修改目标名称')})
  const result=await s.run('click',{target:old})
  assert.equal(result.error_code,'STALE_TARGET')
})

test('duplicate accessible names have distinct exact-node refs', async t => {
  const {s,first} = await fixture(t)
  const saves=first.elements.filter(e=>e.name==='保存')
  assert.equal(saves.length,2)
  assert.notEqual(saves[0].ref,saves[1].ref)
  const v=await s.run('click',{target:saves[1].ref})
  assert.match(v.text,/保存了乙/)
})

test('password values never enter observations, model projections or traces', async t => {
  const {s,first} = await fixture(t)
  for(const filter of ['interactive','all']) {
    const v=await s.run('observe',{filter})
    assert.ok(!JSON.stringify(v).includes('FAKE_PASSWORD_82913'))
    assert.ok(!JSON.stringify(modelObservation(v)).includes('FAKE_PASSWORD_82913'))
  }
  assert.ok(!JSON.stringify(first).includes('FAKE_PASSWORD_82913'))
  assert.ok(!(await readFile(s.tracePath,'utf8')).includes('FAKE_PASSWORD_82913'))
})

test('native select, check and radio use semantic desired-state actions', async t => {
  const {s,first} = await fixture(t)
  let v=await s.run('select',{target:ref(first,'城市'),values:['北京']})
  assert.equal(v.ok,true,JSON.stringify(v))
  v=await s.run('check',{target:ref(v,'同意条款'),checked:true})
  assert.equal(v.elements.find(e=>e.name==='同意条款').checked,true)
  v=await s.run('check',{target:ref(v,'同意条款'),checked:true})
  assert.equal(v.elements.find(e=>e.name==='同意条款').checked,true)
  v=await s.run('check',{target:ref(v,'加急配送'),checked:true})
  assert.equal(v.elements.find(e=>e.name==='加急配送').checked,true)
  assert.equal(v.elements.find(e=>e.name==='城市').value,'bj')
})

test('ARIA tabs and hover menus expose updated semantic state', async t => {
  const {s,first} = await fixture(t)
  let v=await s.run('click',{target:ref(first,'已完成')})
  assert.match(v.accessibility_tree,/tab "已完成".*\[selected=true\]/)
  v=await s.run('hover',{target:ref(v,'更多操作')})
  v=await s.run('click',{target:ref(v,'归档订单')})
  assert.match(v.text,/订单已归档/)
})

test('open shadow DOM inputs and controls are read and operated', async t => {
  const {s,first} = await fixture(t)
  let v=await s.run('fill',{target:ref(first,'影子输入'),text:'shadow内容'})
  v=await s.run('click',{target:ref(v,'保存影子内容')})
  assert.match(v.text,/影子内容：shadow内容/)
})

test('allowed-origin iframe refs resolve to the correct frame nodes', async t => {
  const {s} = await fixture(t)
  await s.page.frameLocator('iframe').getByRole('textbox',{name:'嵌入地址'}).waitFor()
  let v=await s.run('observe')
  v=await s.run('fill',{target:ref(v,'嵌入地址'),text:'上海市测试路'})
  v=await s.run('click',{target:ref(v,'保存嵌入地址')})
  assert.match(v.text,/嵌入保存成功：上海市测试路/)
})

test('scoped reads exclude other regions while preserving reusable refs', async t => {
  const {s,first} = await fixture(t)
  const scope=first.accessibility_tree.match(/form "收货信息" \[ref=([^\]]+)\]/)[1]
  const v=await s.run('observe',{target:scope,filter:'all'})
  assert.match(v.accessibility_tree,/收件人/)
  assert.doesNotMatch(v.accessibility_tree,/稳定目标/)
  assert.equal(ref(v,'收件人'),ref(first,'收件人'))
})

test('find reaches a control omitted by a bounded large-page observation', async t => {
  const {s,lab} = await fixture(t,{maxObservationNodes:25,maxTreeChars:2500})
  let v=await s.run('open',{url:lab.origin+'/large'})
  assert.equal(v.truncated,true)
  assert.ok(!v.elements.some(e=>e.name==='执行任务149'))
  v=await s.run('find',{query:'执行任务149'})
  const action=ref(v,'执行任务149')
  v=await s.run('click',{target:action})
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.equal(await s.page.locator('output').innerText(),'已完成任务149')
})

test('wait observes asynchronous completion without repeated mutation', async t => {
  const {s,first} = await fixture(t)
  await s.run('click',{target:ref(first,'开始异步任务')})
  const v=await s.run('wait',{text:'异步任务已完成',exact:true})
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.match(v.text,/异步任务已完成/)
})

test('model rendering puts the tree first without a duplicate element index', async t => {
  const {first} = await fixture(t)
  const projection=modelObservation(first)
  assert.ok(projection.accessibility_tree)
  assert.equal(projection.elements,undefined)
  assert.equal(projection.text,undefined)
  assert.ok(JSON.stringify(projection).length<JSON.stringify(first).length)
})

test('iframe requests and allowed-origin iframe redirects cannot contact a forbidden origin', async t => {
  const {s,lab}=await fixture(t)
  const other=await startLab({port:0})
  t.after(()=>other.close())
  const foreign=other.origin.replace('127.0.0.1','localhost')
  // Prove the endpoint is reachable independently before testing its denial.
  assert.equal((await fetch(foreign+'/api/state')).status,200)
  let hits=0;other.server.on('request',()=>hits++)
  for(const url of [foreign+'/frame',lab.origin+'/redirect?to='+encodeURIComponent(foreign+'/frame')]){
    await s.page.evaluate(url=>{const f=document.createElement('iframe');f.src=url;document.body.append(f)},url)
    await new Promise(r=>setTimeout(r,350))
  }
  assert.equal(hits,0,'An iframe must not bypass the allowed-origin policy')
})

test('navigation invalidates references from the previous document', async t => {
  const {s,lab,first}=await fixture(t)
  const old=ref(first,'收件人')
  await s.run('open',{url:lab.origin})
  assert.equal((await s.run('fill',{target:old,text:'wrong document'})).error_code,'STALE_TARGET')
})

test('targeted keypress and explicit hidden-state wait have deterministic focus', async t => {
  const {s,first}=await fixture(t)
  const temporary=first.accessibility_tree.match(/status \[ref=([^\]]+)\]: "临时提示"/)[1]
  let v=await s.run('fill',{target:ref(first,'收件人'),text:'ABC'})
  v=await s.run('press',{target:ref(v,'收件人'),key:'ControlOrMeta+A'})
  v=await s.run('press',{target:ref(v,'收件人'),key:'Backspace'})
  assert.equal(v.elements.find(e=>e.name==='收件人').value,'')
  await s.run('click',{target:ref(v,'延迟隐藏提示')})
  assert.equal((await s.run('wait',{target:temporary,state:'hidden'})).ok,true)
})

test('find matches input names without indexing secret or ordinary input values', async t => {
  const {s}=await fixture(t)
  await s.page.getByRole('textbox',{name:'收件人',exact:true}).fill('UNIQUE_ORDINARY_VALUE_448')
  for(const query of ['FAKE_PASSWORD_82913','PASSWORD_829','UNIQUE_ORDINARY_VALUE_448']) {
    const v=await s.run('find',{query})
    assert.equal(v.ok,true,JSON.stringify(v))
    assert.equal(v.accessibility_tree,'')
    assert.deepEqual(v.elements,[])
  }
  const v=await s.run('find',{query:'机密输入'})
  assert.match(v.accessibility_tree,/redacted/)
  assert.ok(!v.accessibility_tree.includes('FAKE_PASSWORD_82913'))
})

test('bounded and scoped reads bind only emitted controls on a large form', async t => {
  const {s}=await fixture(t,{maxObservationNodes:20})
  await s.page.evaluate(()=>{
    document.body.innerHTML='<main>'+Array.from({length:500},(_,i)=>`<label>字段${i}<input value="内容${i}"></label>`).join('')+'</main>'
  })
  let bindings=0
  const original=s.ax.bind.bind(s.ax)
  s.ax.bind=async node=>{bindings++;return original(node)}
  let v=await s.run('observe')
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.equal(v.truncated,true)
  assert.ok(bindings<=20,`Bound ${bindings} controls despite a limit of 20`)
  bindings=0
  v=await s.run('find',{query:'字段499'})
  assert.ok(ref(v,'字段499'))
  assert.ok(bindings<10,`Find needlessly bound ${bindings} controls`)
})

test('navigation during metadata reading repeats only the observation', async t => {
  const {s,lab}=await fixture(t)
  const original=s.ax.bind.bind(s.ax)
  let navigated=false
  s.ax.bind=async node=>{
    const binding=await original(node)
    if(!navigated){navigated=true;await s.page.goto(lab.origin+'/frame')}
    return binding
  }
  const v=await s.run('observe')
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.equal(v.url,lab.origin+'/frame')
  assert.match(v.accessibility_tree,/嵌入地址/)
  assert.doesNotMatch(v.accessibility_tree,/收件人|收货信息/)
  assert.ok(v.elements.every(e=>e.ref.startsWith(`${v.active_tab_id}:d${v.navigation_epoch}:`)))
  assert.equal(lab.state.submissions,0)
})

test('custom ARIA switch check is idempotent', async t => {
  const {s,first}=await fixture(t)
  let v=await s.run('check',{target:ref(first,'消息通知'),checked:true})
  assert.equal(v.ok,true,JSON.stringify(v))
  v=await s.run('check',{target:ref(v,'消息通知'),checked:true})
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.equal(v.elements.find(e=>e.name==='消息通知').checked,true)
})

test('failed fill call logs do not quote the supplied secret', async t => {
  const {s,first}=await fixture(t,{timeoutMs:500})
  await s.page.getByRole('textbox',{name:'机密输入'}).evaluate(el=>el.disabled=true)
  const secret='FAKE_FILLED_SECRET_551'
  const v=await s.run('fill',{target:ref(first,'机密输入'),text:secret})
  assert.equal(v.ok,false)
  assert.ok(!JSON.stringify(v).includes(secret))
  assert.ok(!(await readFile(s.tracePath,'utf8')).includes(secret))
})

test('reference cache eviction retains refs emitted in the current observation', async t => {
  const {s,lab}=await fixture(t,{maxObservationNodes:10,maxTrackedRefs:10})
  await s.run('open',{url:lab.origin+'/large'})
  let v=await s.run('find',{query:'执行任务149'})
  const last=ref(v,'执行任务149')
  await s.run('observe')
  v=await s.run('find',{query:'执行任务149'})
  assert.equal((await s.run('click',{target:ref(v,'执行任务149')})).ok,true)
  assert.ok(last)
})

test('explicit load readiness waits for delayed scripts without replaying a click',async t=>{
  const {s,lab}=await fixture(t)
  let v=await s.run('open',{url:lab.origin+'/load-ready'})
  assert.equal(v.ok,true,JSON.stringify(v))
  v=await s.run('wait',{load_state:'load'})
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.match(v.text,/脚本已就绪/)
  v=await s.run('click',{target:ref(v,'需要初始化的按钮')})
  assert.match(v.text,/初始化后点击成功/)
  assert.equal((await s.run('wait',{text:'初始化后点击成功',load_state:'load'})).error_code,'INVALID_ARGUMENT')
})
