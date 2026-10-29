const{pathToFileURL}=require('node:url'),{resolve}=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict')
;(async()=>{
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/'
 const load=n=>import(pathToFileURL(root+n+'/lib/index.js').href)
 const{Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{ToolRuntime}=await load('dsh-tools')
 const plugin=await import(pathToFileURL(resolve('src/plugin.js')).href),{LEDGER_KEY}=await import(pathToFileURL(resolve('src/ledger-host.js')).href),{startLab}=await import(pathToFileURL(resolve('eval/lab.js')).href)
 const lab=await startLab({port:0}),ctx=new Context();new SessionStore(ctx);new SessionProjectionRegistry(ctx)
 class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}};new Prompt(ctx)
 class Images extends Service{constructor(c){super(c,'attachments')}async saveImages(){return[]}};new Images(ctx)
 const tools=new ToolRuntime(ctx,{mode:'native'}),fiber=ctx.plugin(plugin,{allowedOrigins:[lab.origin],artifactDir:resolve('.artifacts/ledger-browser-traces')});await fiber;await new Promise(r=>setImmediate(r))
 let count=0;const results=[]
 async function invoke(session,name,args={},ptc=false){const id='ledger-'+(++count),agent={session};const base={rootCallId:'ptc-root',parentCallId:'ptc-root',subCallId:id,name,arguments:args}
  if(ptc)session.append('tool/ptc-dispatch-start',base)
  else session.append('tool/call',{turn:1,step:count,callId:id,name,arguments:JSON.stringify(args)})
  const r=await tools.execute({callId:id,name,arguments:args,agent,signal:new AbortController().signal})
  if(ptc)session.append('tool/ptc-dispatch',{...base,isError:!!r.isError,content:r.content})
  else session.append('tool/result',{turn:1,step:count,message:{id:'result-'+id,role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content:r.content,...(r.isError?{isError:true}:{})}},{surfaceOp:'append'})
  return r
 }
 try{
 for(const ptc of [false,true]){
  const session=ctx.sessions.create('ledger-'+ptc)
  session.append('user/message',{id:'request-'+ptc,role:'user',source:{kind:'user'},content:[{type:'text',text:'Only save once. Preserve original errors.'}]},{surfaceOp:'append'})
  await invoke(session,'cu_browser_note',{kind:'decision',text:'createRequire is the only cause'},ptc)
  let memory=(await invoke(session,'cu_browser_memory',{},ptc)).value
  const first=memory.entries.find(e=>e.kind==='decision').id
  await invoke(session,'cu_browser_note',{kind:'decision',text:'Sole cause withdrawn; restart recovery observed',supersedes:first},ptc)
  memory=(await invoke(session,'cu_browser_memory',{},ptc)).value;assert.equal(memory.entries.filter(e=>e.kind==='decision').length,1)
  const invalid=await invoke(session,'cu_browser_note',{kind:'result',text:'fake completion',verified:true,source:'driver'},ptc);assert.ok(invalid.isError)
  const missing=await invoke(session,'cu_browser_note',{kind:'result',text:'invented evidence',evidence:[99999]},ptc);assert.ok(missing.isError)
  const before=ctx.sessionProjections.stateOf(session,LEDGER_KEY)
  // Use a real browser failure for driver evidence, with a stable owning agent.
  const owner={session};const opened=await tools.execute({callId:'open-'+ptc,name:'cu_browser_open',arguments:{url:lab.origin},agent:owner,signal:new AbortController().signal});assert.ok(opened.value.ok)
  session.append(ptc?'tool/ptc-dispatch-start':'tool/call',ptc?{rootCallId:'root',parentCallId:'root',subCallId:'bad-'+ptc,name:'cu_browser_click',arguments:{target:'t1:d1:not-issued'}}:{turn:1,step:1,callId:'bad-'+ptc,name:'cu_browser_click',arguments:'{"target":"t1:d1:not-issued"}'})
  const failed=await tools.execute({callId:'bad-'+ptc,name:'cu_browser_click',arguments:{target:'t1:d1:not-issued'},agent:owner,signal:new AbortController().signal});assert.equal(failed.value.ok,false)
  const event=ptc?session.append('tool/ptc-dispatch',{rootCallId:'root',parentCallId:'root',subCallId:'bad-'+ptc,name:'cu_browser_click',arguments:{target:'t1:d1:not-issued'},isError:false,content:failed.content}):session.append('tool/result',{turn:1,step:1,message:{id:'bad-result-'+ptc,role:'tool',toolCallId:'bad-'+ptc,source:{kind:'tool',callId:'bad-'+ptc},content:failed.content}},{surfaceOp:'append'})
  await invoke(session,'cu_browser_note',{kind:'stage',text:'Inspect the original error before retrying',evidence:[event.seq]},ptc)
  const view=(await invoke(session,'cu_browser_memory',{},ptc)).value;assert.ok(view.entries.some(e=>e.kind==='error'&&e.source==='driver'));assert.ok(view.entries.filter(e=>e.source==='agent').every(e=>!e.verified))
  await tools.execute({callId:'close-'+ptc,name:'cu_browser_close',arguments:{},agent:owner,signal:new AbortController().signal})
  const snapshot=session.snapshotEvents(),restored=ctx.sessions.create('restored-'+ptc,{seed:snapshot});assert.deepEqual(ctx.sessionProjections.stateOf(restored,LEDGER_KEY),ctx.sessionProjections.stateOf(session,LEDGER_KEY))
  const other=ctx.sessions.create('other-'+ptc),denied=await invoke(other,'cu_browser_note',{kind:'result',text:'cross-session evidence',evidence:[event.seq]},ptc);assert.ok(denied.isError)
  assert.equal(before.ledger.entries.filter(e=>e.kind==='decision').length,2)
  results.push({mode:ptc?'ptc':'native',decision_correction:true,source_spoof_rejected:true,invented_evidence_rejected:true,real_browser_error_recorded:true,restored_equal:true,cross_session_denied:true})
 }
 }finally{await fiber.dispose();await lab.close()}
 assert.ok(!tools.schemas().some(t=>t.name.startsWith('cu_browser_')))
 const report={date:new Date().toISOString(),results,model_calls:0,note:'Actual installed DSH Session/projection/tool pipeline and real background browser. PTC dispatch envelopes are simulated; real model PTC is evaluated separately.'};await fs.mkdir('.artifacts',{recursive:true});await fs.writeFile('.artifacts/ledger-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
})().catch(e=>{console.error(e.stack);process.exitCode=1})
