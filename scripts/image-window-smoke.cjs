// Real DSH Session, host image/offload and isolated real attachment store.
const {pathToFileURL}=require('node:url'),{resolve}=require('node:path'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict')
;(async()=>{
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/',load=n=>import(pathToFileURL(root+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{TokenMeter}=await load('dsh-token-meter'),{ToolRuntime}=await load('dsh-tools'),{LocalAttachmentStore}=await load('dsh-attachment-local'),offload=await load('dsh-compaction-image-offload')
 const plugin=await import(pathToFileURL(resolve('src/plugin.js')).href),{HISTORY_KEY}=await import(pathToFileURL(resolve('src/history.js')).href),{applyImageWindow}=await import(pathToFileURL(resolve('src/image-window.js')).href),fixture=JSON.parse(await fs.readFile('test/fixtures/dsh-native-assistant.json','utf8'))
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-image-window-'));let fiber,offloadFiber
 try{
  const ctx=new Context();new SessionStore(ctx);new SessionProjectionRegistry(ctx);new TokenMeter(ctx);const store=new LocalAttachmentStore(ctx,{dshHome:home})
  class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}};new Prompt(ctx)
  class Agents extends Service{constructor(c){super(c,'agents')}};new Agents(ctx)
  const tools=new ToolRuntime(ctx,{mode:'native'});offloadFiber=ctx.plugin(offload,{});await offloadFiber
  fiber=ctx.plugin(plugin,{imagePinsEnabled:true,imageWindowEnabled:true,ptcHistoryEnabled:true,imageWindowKeep:2,historyKeepRecent:1});await fiber;await new Promise(r=>setImmediate(r))
  const session=ctx.sessions.create('window-smoke'),agentCtx=new Context(),agent={ctx:agentCtx,session};await ctx.serial('agent/created',{agent})
  const names=['long-page-find-1','async-condition-1','semantic-checkout-1','aria-components-1','frame-shadow-1'],refs=[]
  for(const name of names){const data=await fs.readFile('.artifacts/eval/2026-10-27T14-52-40.940Z/'+name+'.png');const [ref]=await store.saveImages([{data,mediaType:'image/png',name:name+'.png'}]);refs.push(ref)}
  assert.equal(new Set(refs.map(x=>x.attachmentId)).size,5)
  const rows=[]
  for(let i=0;i<5;i++){
   const id='window-call-'+i,data=JSON.parse(JSON.stringify(fixture.assistant).replaceAll(fixture.callId,id).replaceAll('cu_browser_open','cu_browser_screenshot'));data.step=i+1;data.message.id='window-assistant-'+i
   session.append('assistant/message',data,{surfaceOp:'append'});session.append('tool/call',{turn:1,step:i+1,callId:id,name:'cu_browser_screenshot',arguments:'{}'})
   const result=session.append('tool/result',{turn:1,step:i+1,message:{id:'window-result-'+i,role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content:[{type:'text',text:JSON.stringify({ok:true,accessibility_tree:'- status: '+i+'\n'+'x'.repeat(12000)})},{type:'image',attachment:refs[i]}]}},{surfaceOp:'append'});rows.push(result.seq)
  }
  const args={event_seq:rows[0],pinned:true},pinId='window-pin';session.append('tool/call',{turn:1,step:6,callId:pinId,name:'cu_browser_image_pin',arguments:JSON.stringify(args)})
  const pin=await tools.execute({callId:pinId,name:'cu_browser_image_pin',arguments:args,agent,signal:new AbortController().signal});assert.equal(pin.value.accepted,true)
  session.append('tool/result',{turn:1,step:6,message:{id:'pin-result',role:'tool',toolCallId:pinId,source:{kind:'tool',callId:pinId},content:pin.content}},{surfaceOp:'append'})
  const noHostCtx=new Context();new SessionStore(noHostCtx)
  const noHost=noHostCtx.sessions.create('window-no-host',{seed:session.snapshotEvents()}),noHostSeq=noHost.seq
  const noHostResult=await applyImageWindow(noHost,ctx.sessionProjections.stateOf(session,HISTORY_KEY),{pinned:[rows[0]],limited:false},store,{keep:2})
  assert.equal(noHostResult.status,'host_projection_unavailable');assert.equal(noHost.seq,noHostSeq,'unsupported projection must not append')
  const status=()=>tools.execute({callId:'window-status',name:'cu_browser_image_window_status',arguments:{},agent,signal:new AbortController().signal})
  assert.equal((await status()).value.status,'not_run')
  await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
  assert.equal((await status()).value.status,'pending_input_unknown')
  await agentCtx.waterfall('agent/pre-step',{messages:[{source:{kind:'user'}}]},()=>Promise.resolve({kind:'enter',messages:[{source:{kind:'user'}}]}))
  await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
  assert.equal((await status()).value.status,'pending_input_deferred')
  assert.ok(session.deriveMessages().filter(m=>m.id?.startsWith('window-result-')).every(m=>m.content.find(b=>b.type==='image').offloaded!==true),'new user input is seen before any image is offloaded')
  await agentCtx.waterfall('agent/pre-step',{messages:[]},()=>Promise.resolve({kind:'enter',messages:[]}))
  await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
  assert.equal((await status()).value.status,'offloaded');assert.equal((await status()).value.offloaded,2)
  const images=session.deriveMessages().filter(m=>m.id?.startsWith('window-result-')).map(m=>m.content.find(b=>b.type==='image'))
  assert.deepEqual(images.map(b=>b.offloaded===true),[false,true,true,false,false])
  const history=ctx.sessionProjections.stateOf(session,HISTORY_KEY);assert.ok(history.rows.filter(r=>r.name==='cu_browser_screenshot').slice(0,4).every(r=>r.live_seq!==undefined),'older replaced screenshot mappings retained')
  const recall=await tools.execute({callId:'window-recall',name:'cu_browser_image_recall',arguments:{event_seq:rows[1]},agent,signal:new AbortController().signal});assert.equal(recall.value.ok,true);assert.equal(recall.content.find(b=>b.type==='image').attachment.attachmentId,refs[1].attachmentId)
  const beforeSeq=session.seq;await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}));assert.equal(session.seq,beforeSeq,'window is idempotent')
  const restored=ctx.sessions.create('window-restored',{seed:session.snapshotEvents()});assert.deepEqual(restored.deriveMessages(),session.deriveMessages())
  const ptc=ctx.sessions.create('ptc-window-smoke'),ptcCtx=new Context(),ptcAgent={ctx:ptcCtx,session:ptc};await ctx.serial('agent/created',{agent:ptcAgent});const ptcRows=[]
  for(let i=0;i<5;i++){
   const callId='ptc-window-'+i,subCallId=callId+':1',data=JSON.parse(JSON.stringify(fixture.assistant).replaceAll(fixture.callId,callId).replaceAll('cu_browser_open','run_code'));data.step=i+1;data.message.id='ptc-assistant-'+i
   ptc.append('assistant/message',data,{surfaceOp:'append'});ptc.append('tool/call',{turn:1,step:i+1,callId,name:'run_code',arguments:'{}'})
   const value={ok:true,observation_id:'ptc-'+i,accessibility_tree:'- status: '+i+'\n'+'x'.repeat(12000)},content=[{type:'text',text:JSON.stringify(value)},{type:'image',attachment:refs[i]}]
   ptc.append('tool/ptc-dispatch-start',{rootCallId:callId,parentCallId:callId,subCallId,name:'cu_browser_screenshot',arguments:{}})
   ptc.append('tool/ptc-dispatch',{rootCallId:callId,parentCallId:callId,subCallId,name:'cu_browser_screenshot',arguments:{},isError:false,content})
   ptc.append('tool/result',{turn:1,step:i+1,message:{id:'ptc-result-'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[content[0]]}},{surfaceOp:'append'})
   const image=ptc.append('user/message',{id:'ptc-image-'+i,role:'user',source:{kind:'ptc-mode'},content},{surfaceOp:'append'});ptcRows.push(image.seq)
  }
  const ptcPin={event_seq:ptcRows[0],pinned:true},ptcPinId='ptc-pin';ptc.append('tool/ptc-dispatch-start',{rootCallId:'pin-root',parentCallId:'pin-root',subCallId:ptcPinId,name:'cu_browser_image_pin',arguments:ptcPin})
  const ptcPending=await tools.execute({callId:ptcPinId,name:'cu_browser_image_pin',arguments:ptcPin,agent:ptcAgent,signal:new AbortController().signal});assert.equal(ptcPending.value.accepted,true)
  ptc.append('tool/ptc-dispatch',{rootCallId:'pin-root',parentCallId:'pin-root',subCallId:ptcPinId,name:'cu_browser_image_pin',arguments:ptcPin,isError:false,content:ptcPending.content})
  await ptcCtx.waterfall('agent/pre-step',{messages:[]},()=>Promise.resolve({kind:'enter',messages:[]}))
  await ptcCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
  const ptcImages=ptc.deriveMessages().filter(m=>m.id?.startsWith('ptc-image-')).map(m=>m.content.find(b=>b.type==='image'))
  assert.deepEqual(ptcImages.map(b=>b.offloaded===true),[false,true,true,false,false])
  const ptcRecall=await tools.execute({callId:'ptc-recall',name:'cu_browser_image_recall',arguments:{event_seq:ptcRows[1]},agent:ptcAgent,signal:new AbortController().signal});assert.equal(ptcRecall.value.ok,true);assert.equal(ptcRecall.content.find(b=>b.type==='image').attachment.attachmentId,refs[1].attachmentId)
  const ptcRestored=ctx.sessions.create('ptc-window-restored',{seed:ptc.snapshotEvents()});assert.deepEqual(ptcRestored.deriveMessages(),ptc.deriveMessages())
  console.log(JSON.stringify({real_session:true,real_attachment_store:true,host_offload:true,missing_projection_no_mutation:true,pending_user_input_deferred:true,unknown_pending_state_deferred:true,pinned_preserved:true,recent_preserved:2,older_offloaded:2,recall_passed:true,idempotent:true,restored_equal:true,simulated_ptc_window:true,ptc_pin_recall_restore:true,model_calls:0}))
 }finally{await fiber?.dispose();await offloadFiber?.dispose();await fs.rm(home,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack);process.exitCode=1})
