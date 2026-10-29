import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,rm,readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BrowserSession } from '../src/browser.js'
import { startLab } from '../eval/lab.js'
import {createHash} from 'node:crypto'
import {createServer as createHttpsServer} from 'node:https'
import {spawnSync} from 'node:child_process'

async function fixture(t,config={}) {
  const lab=await startLab({port:0}),dir=await mkdtemp(join(tmpdir(),'cu-tabs-'))
  const s=new BrowserSession({headless:true,allowedOrigins:[lab.origin],artifactDir:dir,...config})
  t.after(async()=>{await s.shutdown();await lab.close();await rm(dir,{recursive:true,force:true})})
  const first=await s.run('open',{url:lab.origin+'/tabs'})
  assert.equal(first.ok,true,JSON.stringify(first))
  return {s,lab,first}
}
function ref(v,name){assert.equal(v.ok,true,JSON.stringify(v));const node=v.elements.find(e=>e.name===name);assert.ok(node,'Missing '+name);return node.ref}
async function until(predicate){const end=Date.now()+3000;while(!await predicate()){assert.ok(Date.now()<end,'Condition timed out');await new Promise(r=>setTimeout(r,10))}}

test('each tab owns its AX refs and switching back preserves unchanged nodes',async t=>{
  const {s,lab,first}=await fixture(t)
  const original=ref(first,'备注'),a=first.active_tab_id
  let v=await s.run('tab_new',{url:lab.origin+'/tab-detail'})
  const b=v.active_tab_id,other=ref(v,'备注')
  assert.notEqual(a,b);assert.notEqual(original,other)
  assert.equal((await s.run('fill',{target:original,text:'wrong tab'})).error_code,'WRONG_TAB')
  v=await s.run('fill',{target:other,text:'明细备注'})
  assert.equal(v.ok,true,JSON.stringify(v))
  v=await s.run('tab_switch',{tab_id:a})
  assert.equal(ref(v,'备注'),original)
  v=await s.run('fill',{target:original,text:'工作台备注'})
  assert.equal(v.elements.find(e=>e.name==='备注').value,'工作台备注')
  await s.run('tab_switch',{tab_id:b})
  assert.equal(await s.page.getByRole('textbox',{name:'备注',exact:true}).inputValue(),'明细备注')
})

test('a real popup remains open and is explicitly selectable without stealing refs',async t=>{
  const {s,first}=await fixture(t)
  const popup=s.context.waitForEvent('page')
  let v=await s.run('click',{target:ref(first,'打开订单明细')})
  const page=await popup
  assert.equal(v.active_tab_id,first.active_tab_id)
  const listed=await s.run('tabs')
  assert.equal(listed.tabs.length,2)
  const child=listed.tabs.find(tab=>tab.url.endsWith('/tab-detail'))
  assert.equal(child.opener_tab_id,first.active_tab_id)
  assert.equal(page.isClosed(),false)
  v=await s.run('tab_switch',{tab_id:child.tab_id})
  assert.equal(v.title,'订单明细')
  v=await s.run('find',{query:'本轮核对码'})
  assert.match(v.text,/TAB829/)
  assert.ok(v.elements.every(e=>e.ref.startsWith(child.tab_id+':')))
})

test('tab close selects a remaining tab; closing all retains the context for a new tab',async t=>{
  const {s,lab,first}=await fixture(t)
  const context=s.context
  let v=await s.run('tab_new',{url:lab.origin+'/tab-detail'}),b=v.active_tab_id
  v=await s.run('tab_close',{tab_id:b})
  assert.equal(v.active_tab_id,first.active_tab_id)
  assert.equal((await s.run('tab_switch',{tab_id:b})).error_code,'UNKNOWN_TAB')
  v=await s.run('tab_close',{tab_id:first.active_tab_id})
  assert.equal(v.ok,true,JSON.stringify(v));assert.equal(v.active_tab_id,null)
  assert.deepEqual(v.tabs,[]);assert.equal(s.context,context)
  v=await s.run('tab_new',{url:lab.origin+'/tabs'})
  assert.equal(v.ok,true,JSON.stringify(v));assert.notEqual(v.active_tab_id,b)
  assert.equal(s.context,context)
})

test('history back, forward and reload produce new observations and retire old refs',async t=>{
  const {s,lab}=await fixture(t)
  let v=await s.run('open',{url:lab.origin+'/history-a'})
  const old=ref(v,'备忘')
  v=await s.run('click',{target:ref(v,'打开页面乙')})
  assert.equal(v.url,lab.origin+'/history-b');assert.equal(v.history.can_back,true)
  v=await s.run('history',{direction:'back'})
  assert.equal(v.title,'历史页面甲');assert.equal(v.history.can_forward,true)
  assert.equal((await s.run('fill',{target:old,text:'old doc'})).error_code,'STALE_TARGET')
  v=await s.run('history',{direction:'forward'});assert.equal(v.title,'历史页面乙')
  const before=ref(v,'备忘')
  v=await s.run('history',{direction:'reload'});assert.equal(v.title,'历史页面乙')
  assert.notEqual(ref(v,'备忘'),before)
  assert.equal((await s.run('history',{direction:'sideways'})).error_code,'INVALID_ARGUMENT')
})

test('target=_blank form preserves the actual POST exactly once',async t=>{
  const {s,lab,first}=await fixture(t)
  let v=await s.run('fill',{target:ref(first,'备注'),text:'实际 POST 内容'})
  const created=s.context.waitForEvent('page')
  v=await s.run('click',{target:ref(v,'打开提交结果')})
  const page=await created;await page.waitForLoadState('domcontentloaded')
  assert.equal(lab.state.popupSubmissions,1);assert.equal(lab.state.popupNote,'实际 POST 内容')
  const list=await s.run('tabs'),tab=list.tabs.find(x=>x.url.endsWith('/popup-submit'))
  assert.ok(tab);v=await s.run('tab_switch',{tab_id:tab.tab_id})
  assert.match(v.text,/弹窗提交成功/)
})

test('new tabs share only this temporary context and closing one keeps its cookies',async t=>{
  const {s,lab,first}=await fixture(t)
  await s.page.evaluate(()=>{document.cookie='tab_token=TEST_SHARED_COOKIE';localStorage.setItem('tabState','shared')})
  let v=await s.run('tab_new',{url:lab.origin+'/tab-detail'})
  assert.deepEqual(await s.page.evaluate(()=>[document.cookie,localStorage.getItem('tabState')]),['tab_token=TEST_SHARED_COOKIE','shared'])
  await s.run('tab_close',{tab_id:first.active_tab_id})
  assert.equal((await s.run('tabs')).tabs.length,1)
  assert.equal(await s.page.evaluate(()=>localStorage.getItem('tabState')),'shared')
})

test('switching tabs expires visual coordinates even after switching back',async t=>{
  const {s,lab,first}=await fixture(t)
  const image=await s.run('screenshot')
  const b=await s.run('tab_new',{url:lab.origin+'/tab-detail'})
  assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:10,y:10})).error_code,'STALE_SCREENSHOT')
  await s.run('tab_switch',{tab_id:first.active_tab_id})
  assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:10,y:10})).error_code,'STALE_SCREENSHOT')
  const fresh=await s.run('screenshot')
  assert.equal(fresh.visual_context.tab_id,first.active_tab_id)
  assert.notEqual(fresh.visual_context.tab_id,b.active_tab_id)
})

test('popup direct requests and each redirect hop are denied before contacting another origin',async t=>{
  const {s,lab}=await fixture(t)
  const other=await startLab({port:0});t.after(()=>other.close())
  const foreign=other.origin.replace('127.0.0.1','localhost')
  assert.equal((await fetch(foreign+'/api/state')).status,200)
  let hits=0;other.server.on('request',()=>hits++)
  const destinations=[foreign+'/direct',lab.origin+'/redirect?to='+encodeURIComponent(foreign+'/after-redirect')]
  for(const [i,url] of destinations.entries()){
    await s.page.evaluate(({url,i})=>{const a=document.createElement('a');a.href=url;a.target='_blank';a.textContent='边界检查'+i;document.body.append(a)},{url,i})
    const v=await s.run('observe'),created=s.context.waitForEvent('page')
    await s.run('click',{target:ref(v,'边界检查'+i)})
    const page=await created;await page.waitForLoadState().catch(()=>{})
    assert.equal(hits,0)
    await page.close()
  }
  assert.ok(s.networkDenied.includes(foreign))
})

test('an about:blank popup inherits an allowed origin verified from Chromium',async t=>{
  const {s}=await fixture(t)
  const created=s.context.waitForEvent('page')
  await s.page.evaluate(()=>{const child=window.open('about:blank');child.document.write('<title>继承来源</title><label>弹窗输入<input></label><output>未编辑</output>')})
  const page=await created
  const child=(await s.run('tabs')).tabs.find(x=>x.url==='about:blank')
  assert.ok(child)
  let v=await s.run('tab_switch',{tab_id:child.tab_id})
  assert.equal(v.ok,true,JSON.stringify(v));assert.equal(v.title,'继承来源')
  v=await s.run('fill',{target:ref(v,'弹窗输入'),text:'临时内容'})
  assert.equal(v.ok,true,JSON.stringify(v));assert.equal(await page.getByRole('textbox').inputValue(),'临时内容')
})

test('tab limit closes a popup while paused before its first HTTP request',async t=>{
  const {s,lab,first}=await fixture(t,{maxTabs:1})
  let detailHits=0;lab.server.on('request',r=>{if(r.url==='/tab-detail')detailHits++})
  assert.equal((await s.run('tab_new',{url:lab.origin+'/tab-detail'})).error_code,'TAB_LIMIT')
  await s.run('click',{target:ref(first,'打开订单明细')})
  await until(()=>s.tabEvents.some(e=>e.type==='tab_limit'))
  assert.equal(detailHits,0)
  await until(()=>s.context.pages().length===1)
  assert.equal((await s.run('tabs')).tabs.length,1)
})

test('browser request guard disconnection closes every tab and rejects later actions',async t=>{
  const {s,lab}=await fixture(t)
  await s.run('tab_new',{url:lab.origin+'/tab-detail'})
  const browser=s.browser
  s.guard.socket.close()
  await until(()=>s.stopped)
  await s.closePromise
  assert.equal(browser.isConnected(),false)
  assert.equal(s.tabs.records.size,0)
  assert.equal((await s.run('observe')).error_code,'SESSION_CLOSED')
})

test('dedicated Worker HTTP requests and redirects inherit the parent page guard',async t=>{
  const {s,lab}=await fixture(t)
  const other=await startLab({port:0});t.after(()=>other.close())
  assert.equal((await fetch(other.origin+'/api/state')).status,200)
  let hits=0;other.server.on('request',()=>hits++)
  const result=await s.page.evaluate(async({origin,foreign})=>{
    const program=`onmessage=async()=>{const results=[];for(const url of ${JSON.stringify([origin+'/api/state',foreign+'/denied',origin+'/redirect?to='+encodeURIComponent(foreign+'/redirected')])}){try{const r=await fetch(url);results.push(r.ok)}catch{results.push(false)}};postMessage(results)}`
    const url=URL.createObjectURL(new Blob([program],{type:'text/javascript'})),worker=new Worker(url)
    try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker did not finish')),3000);worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.postMessage('start')})}
    finally{worker.terminate();URL.revokeObjectURL(url)}
  },{origin:lab.origin,foreign:other.origin})
  assert.deepEqual(result,[true,false,false]);assert.equal(hits,0)
})

test('background navigation does not invalidate the selected tab references',async t=>{
  const {s,lab,first}=await fixture(t)
  let v=await s.run('tab_new',{url:lab.origin+'/tab-detail'})
  const memo=ref(v,'备注')
  await s.tabs.get(first.active_tab_id).page.goto(lab.origin+'/history-a')
  v=await s.run('fill',{target:memo,text:'当前页未变化'})
  assert.equal(v.ok,true,JSON.stringify(v));assert.equal(ref(v,'备注'),memo)
  await s.run('tab_switch',{tab_id:first.active_tab_id})
  assert.equal((await s.run('fill',{target:ref(first,'核对码'),text:'旧文档'})).error_code,'STALE_TARGET')
})

test('a popup can close itself without redirecting an action to another tab',async t=>{
  const {s,first}=await fixture(t)
  const created=s.context.waitForEvent('page')
  await s.run('click',{target:ref(first,'打开订单明细')});await created
  const child=(await s.run('tabs')).tabs.find(tab=>tab.url.endsWith('/tab-detail'))
  let v=await s.run('tab_switch',{tab_id:child.tab_id})
  await s.run('click',{target:ref(v,'关闭明细页')})
  v=await s.run('observe')
  assert.equal(v.ok,true,JSON.stringify(v));assert.equal(v.active_tab_id,first.active_tab_id)
  assert.equal(v.tabs.length,1);assert.equal(v.title,'标签页收集台')
})

test('page and Worker WebSockets cannot connect to unconfigured origins',async t=>{
  const {s,lab}=await fixture(t)
  const other=await startLab({port:0});t.after(()=>other.close())
  let allowed=0,denied=0
  const serve=(server,count)=>server.on('upgrade',(req,socket)=>{
    count();const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n')
    socket.on('data',()=>socket.destroy());socket.on('error',()=>{})
  })
  serve(lab.server,()=>allowed++);serve(other.server,()=>denied++)
  const urls=[lab.origin.replace('http:','ws:')+'/allowed',other.origin.replace('http:','ws:')+'/denied']
  for(const worker of [false,true]){
    const result=await s.page.evaluate(async({urls,worker})=>{
      const source=`async function connect(url){return await new Promise(resolve=>{const socket=new WebSocket(url);let opened=false;const timer=setTimeout(()=>{socket.close();resolve({timeout:true})},2000);socket.onopen=()=>{opened=true;socket.send('probe')};socket.onerror=()=>{};socket.onclose=e=>{clearTimeout(timer);resolve({opened,code:e.code})}})};async function run(){const output=[];for(const url of ${JSON.stringify(urls)})output.push(await connect(url));return output}`
      if(!worker)return await new Function(source+';return run()')()
      const url=URL.createObjectURL(new Blob([source+';run().then(value=>postMessage(value))'],{type:'text/javascript'})),w=new Worker(url)
      try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker timed out')),6000);w.onmessage=e=>{clearTimeout(timer);resolve(e.data)}})}finally{w.terminate();URL.revokeObjectURL(url)}
    },{urls,worker})
    assert.equal(result[0].opened,true,JSON.stringify(result))
    assert.equal(denied,0,`A ${worker?'Worker':'page'} WebSocket reached a forbidden origin`)
  }
  assert.equal(allowed,2)
})

test('HTTPS and WSS use allowed TLS tunnels; foreign ports receive no connection',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'cu-tls-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const certificate=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore'})
  assert.equal(certificate.status,0,'OpenSSL is required for the local TLS integration fixture')
  const options={key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))}
  const allowed=createHttpsServer(options,(_req,res)=>res.end('<!doctype html><meta charset="utf-8"><title>TLS fixture</title><h1>TLS fixture</h1>'))
  const foreign=createHttpsServer(options,(_req,res)=>res.end('foreign'))
  const sockets=new Set();let foreignConnections=0,upgrades=0
  for(const server of [allowed,foreign])server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
  foreign.on('connection',()=>foreignConnections++)
  allowed.on('upgrade',(req,socket)=>{
    upgrades++;const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',()=>socket.destroy());socket.on('error',()=>{})
  })
  await Promise.all([allowed,foreign].map(server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))))
  t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([allowed,foreign].map(server=>new Promise(resolve=>server.close(resolve))))})
  const origin='https://127.0.0.1:'+allowed.address().port,other='wss://127.0.0.1:'+foreign.address().port
  const s=new BrowserSession({headless:true,allowedOrigins:[origin],artifactDir:dir})
  t.after(()=>s.shutdown())
  // Test-only: trust this generated one-day local certificate through CDP.
  // The production plugin exposes no certificate bypass or arbitrary CDP tool.
  await s.start()
  const page=await s.createTab(),cdp=await s.tabs.cdp(page)
  await cdp.send('Security.setIgnoreCertificateErrors',{ignore:true})
  const opened=await s.run('open',{url:origin})
  assert.equal(opened.ok,true,JSON.stringify(opened));assert.equal(opened.title,'TLS fixture')
  for(const worker of [false,true]){
    const result=await s.page.evaluate(async({url,other,worker})=>{
      const source=`async function attempt(url){return await new Promise(resolve=>{const ws=new WebSocket(url);const timer=setTimeout(()=>{ws.close();resolve(false)},2500);ws.onopen=()=>{clearTimeout(timer);ws.send('probe');resolve(true)};ws.onerror=()=>{clearTimeout(timer);resolve(false)}})};async function run(){return [await attempt(${JSON.stringify(url)}),await attempt(${JSON.stringify(other)})]}`
      if(!worker)return await new Function(source+';return run()')()
      const blob=URL.createObjectURL(new Blob([source+';run().then(value=>postMessage(value))'],{type:'text/javascript'})),w=new Worker(blob)
      try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('TLS worker timeout')),6000);w.onmessage=e=>{clearTimeout(timer);resolve(e.data)}})}finally{w.terminate();URL.revokeObjectURL(blob)}
    },{url:origin.replace('https:','wss:')+'/allowed',other,worker})
    assert.deepEqual(result,[true,false])
  }
  assert.equal(upgrades,2);assert.equal(foreignConnections,0)
})

test('origin proxy failure retires the whole browser, including open tabs',async t=>{
  const {s,lab}=await fixture(t)
  await s.run('tab_new',{url:lab.origin+'/tab-detail'})
  const browser=s.browser
  s.proxy.server.close()
  await until(()=>s.stopped);await s.closePromise
  assert.equal(browser.isConnected(),false);assert.equal(s.proxy.sockets.size,0)
})

test('wait(tab_count) observes a delayed popup exactly once without reopening the link',async t=>{
  const {s,lab}=await fixture(t)
  let detailHits=0
  lab.server.on('request',req=>{if(req.url==='/tab-delayed')detailHits++})
  await s.page.evaluate(()=>{const a=document.createElement('a');a.href='/tab-delayed';a.target='_blank';a.textContent='延迟打开明细';document.body.append(a)})
  const value=await s.run('observe')
  await s.run('click',{target:ref(value,'延迟打开明细')})
  const pending=await s.run('tabs')
  assert.equal(pending.tabs.length,1);assert.equal(pending.opening_tabs.length,1)
  const waiting=s.run('wait',{tab_count:2})
  lab.releaseDelayedTab()
  const ready=await waiting
  assert.equal(ready.ok,true,JSON.stringify(ready))
  assert.equal(ready.tabs.length,2);assert.deepEqual(ready.opening_tabs,[])
  assert.equal(detailHits,1)
  assert.equal((await s.run('wait',{tab_count:3,timeout_ms:80})).error_code,'WAIT_TIMEOUT')
  assert.equal((await s.run('tabs')).tabs.length,2)
  assert.equal(detailHits,1)
})
