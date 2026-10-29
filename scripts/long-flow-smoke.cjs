// Program-driven long-flow evaluation against a real isolated browser, DSH
// session/projections/tool runtime and attachment store. No model is called.
const {pathToFileURL}=require('node:url'),{resolve}=require('node:path'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
;(async()=>{
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/',load=n=>import(pathToFileURL(root+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{TokenMeter}=await load('dsh-token-meter'),{ToolRuntime}=await load('dsh-tools'),{LocalAttachmentStore}=await load('dsh-attachment-local'),offload=await load('dsh-compaction-image-offload')
 const plugin=await import(pathToFileURL(resolve('src/plugin.js')).href),{HISTORY_KEY}=await import(pathToFileURL(resolve('src/history.js')).href),{STATE_KEY}=await import(pathToFileURL(resolve('src/task-state.js')).href),{startLab}=await import(pathToFileURL(resolve('eval/lab.js')).href)
 const fixture=JSON.parse(await fs.readFile('test/fixtures/dsh-native-assistant.json','utf8')),home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-long-flow-'))
 const paths=[...(await fs.readdir('src')).filter(n=>n.endsWith('.js')).map(n=>'src/'+n),'eval/lab.js','eval/lab.html','package-lock.json','test/fixtures/dsh-native-assistant.json','scripts/long-flow-smoke.cjs'].sort()
 const fingerprint=async()=>{const hash=createHash('sha256');for(const file of paths){hash.update(file+'\0');hash.update(await fs.readFile(file))}return hash.digest('hex')}
 const sourceHash=await fingerprint()
 const compactDuplicates=process.env.DSH_CU_COMPACT_DUPLICATES==='1'
 const lab=await startLab({port:0}),ctx=new Context();new SessionStore(ctx);new SessionProjectionRegistry(ctx);new TokenMeter(ctx);new LocalAttachmentStore(ctx,{dshHome:home})
 class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}};new Prompt(ctx)
 class Agents extends Service{constructor(c){super(c,'agents')}};new Agents(ctx)
 const tools=new ToolRuntime(ctx,{mode:'native'}),offloadFiber=ctx.plugin(offload,{});await offloadFiber
 const fiber=ctx.plugin(plugin,{allowedOrigins:[lab.origin],artifactDir:path.join(home,'traces'),maxSteps:150,historyKeepRecent:4,ptcHistoryEnabled:true,ptcCompactDuplicatesEnabled:compactDuplicates,taskStateEnabled:true,imagePinsEnabled:true,imageWindowEnabled:true,imageWindowKeep:2});await fiber;await new Promise(r=>setImmediate(r))
 try{
  const report=[]
  for(const mode of ['native','ptc']){
   const session=ctx.sessions.create('long-'+mode),agentCtx=new Context(),agent={ctx:agentCtx,session};await ctx.serial('agent/created',{agent});let count=0,latest,shotSeq,pinSeq;const checkpoints=[]
   session.append('user/message',{id:'first-'+mode,role:'user',source:{kind:'user'},content:[{type:'text',text:'Only save once. Remember the first error and keep the first screenshot.'}]},{surfaceOp:'append'})
   session.append('turn/start',{turn:1})
   async function invoke(name,args={}){
    const index=++count,rootId=mode+'-root-'+index,subId=rootId+':1',actual=mode==='native'?name:'run_code'
    session.append('step/start',{turn:1,step:index})
    const assistant=JSON.parse(JSON.stringify(fixture.assistant).replaceAll(fixture.callId,rootId).replaceAll('cu_browser_open',actual));assistant.step=index;assistant.message.id=mode+'-assistant-'+index
    session.append('assistant/message',assistant,{surfaceOp:'append'});session.append('tool/call',{turn:1,step:index,callId:rootId,name:actual,arguments:JSON.stringify(mode==='native'?args:{code:'fixture'})})
    if(mode==='ptc')session.append('tool/ptc-dispatch-start',{rootCallId:rootId,parentCallId:rootId,subCallId:subId,name,arguments:args})
    const result=await tools.execute({callId:mode==='native'?rootId:subId,name,arguments:args,agent,signal:new AbortController().signal})
    if(mode==='ptc')session.append('tool/ptc-dispatch',{rootCallId:rootId,parentCallId:rootId,subCallId:subId,name,arguments:args,isError:!!result.isError,content:result.content})
    const content=mode==='native'?result.content:[{type:'text',text:JSON.stringify(result.value??{error:true})}]
    const event=session.append('tool/result',{turn:1,step:index,message:{id:mode+'-result-'+index,role:'tool',toolCallId:rootId,source:{kind:'tool',callId:rootId},content,...(result.isError?{isError:true}:{})}},{surfaceOp:'append'})
    let imageEvent
    if(mode==='ptc'&&result.content.some(b=>b.type==='image'))imageEvent=session.append('user/message',{id:mode+'-image-'+index,role:'user',source:{kind:'ptc-mode'},content:result.content},{surfaceOp:'append'})
    session.append('step/end',{turn:1,step:index})
    if(name.startsWith('cu_browser_')&&result.value?.ok&&result.value.elements)latest=result.value
    return {value:result.value,isError:!!result.isError,seq:imageEvent?.seq??event.seq}
   }
   const ref=name=>{const e=latest?.elements?.find(x=>x.name===name);assert.ok(e,'missing control '+name);return e.ref}
   async function checkpoint(){
    const before=ctx.tokenMeter.measure(session).totalTokens
    await agentCtx.waterfall('agent/pre-step',{messages:[]},()=>Promise.resolve({kind:'enter',messages:[]}))
    await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
    checkpoints.push({before_estimate:before,after_estimate:ctx.tokenMeter.measure(session).totalTokens})
   }
   const denied=await invoke('cu_browser_open',{url:lab.origin.replace('127.0.0.1','localhost')});assert.equal(denied.value.error_code,'ORIGIN_DENIED')
   assert.equal((await invoke('cu_browser_open',{url:lab.origin})).value.ok,true)
   await invoke('cu_browser_note',{kind:'decision',text:'Initial plan: use the first title'})
   let memory=await invoke('cu_browser_memory',{});const first=memory.value.entries.find(e=>e.kind==='decision').id
   await invoke('cu_browser_note',{kind:'decision',text:'Correction: use the final title',supersedes:first})
   for(let i=0;i<50;i++){
    if(i%10===0){await invoke('cu_browser_fill',{target:ref('标题'),text:'temporary '+i});const shot=await invoke('cu_browser_screenshot');assert.equal(shot.value.ok,true);shotSeq=shot.seq;if(pinSeq===undefined){pinSeq=shotSeq;const pin=await invoke('cu_browser_image_pin',{event_seq:pinSeq,pinned:true});assert.equal(pin.value.accepted,true)}}
    const observation=await invoke('cu_browser_observe');assert.equal(observation.value.ok,true)
    if(i===24)session.append('user/message',{id:'correction-'+mode,role:'user',source:{kind:'user'},content:[{type:'text',text:'Use final title: Long Flow. Still save exactly once.'}]},{surfaceOp:'append'})
    if(i%10===9)await checkpoint()
   }
   await invoke('cu_browser_fill',{target:ref('标题'),text:'Long Flow'});await invoke('cu_browser_fill',{target:ref('描述'),text:'single save'})
   await invoke('cu_browser_click',{target:ref('保存任务')});const waited=await invoke('cu_browser_wait',{text:'保存成功'});assert.equal(waited.value.ok,true)
   assert.equal(lab.state.submissions,mode==='native'?1:2);assert.deepEqual(lab.state.last,{title:'Long Flow',description:'single save'})
   await checkpoint()
   const state=ctx.sessionProjections.stateOf(session,STATE_KEY);assert.ok(state.message,'current task state exists')
   const summary=JSON.parse(state.message.content[0].text).summary
   assert.match(summary.first_error.text,/ORIGIN_DENIED/);assert.ok(summary.decisions.some(e=>e.text.includes('Correction')));assert.ok(!summary.decisions.some(e=>e.text.includes('Initial plan')))
   assert.ok(summary.user_intent.recent.some(e=>e.text.includes('Long Flow')))
   const hist=ctx.sessionProjections.stateOf(session,HISTORY_KEY),old=hist.rows.find(r=>r.name==='cu_browser_observe'&&!session.surface.nodes.includes(r.seq));assert.ok(old,'an old observation was compacted')
   const messages=session.deriveMessages(),estimatedByRole={}
   for(const message of messages)estimatedByRole[message.role]=(estimatedByRole[message.role]??0)+ctx.tokenMeter.estimateMessage(message)
   let retainedPtcDuplicateChars=0
   for(const message of messages.filter(m=>m.role==='tool')){try{const value=JSON.parse(message.content.find(b=>b.type==='text')?.text);if(value?.computer_use_history){retainedPtcDuplicateChars+=(typeof value.text==='string'?value.text.length:0)+(value.elements===undefined?0:JSON.stringify(value.elements).length)}}catch{}}
   const currentImages=hist.rows.filter(r=>r.name==='cu_browser_screenshot').map(row=>{
    const original=row.mode==='ptc-image'?row.data:row.data?.message
    if(!original?.content?.some(b=>b.type==='image'))return null
    const live=messages.find(m=>m.id===original.id)
    return {seq:row.seq,offloaded:live?.content?.find(b=>b.type==='image')?.offloaded===true}
   }).filter(Boolean)
   assert.equal(currentImages.find(x=>x.seq===pinSeq)?.offloaded,false,'the pinned screenshot stays visible under this plugin policy')
   const offloadedImage=currentImages.find(x=>x.offloaded);assert.ok(offloadedImage,'an unpinned historical screenshot was offloaded')
   let cursor=0,entries=[]
   do {const page=await invoke('cu_browser_memory',{after_id:cursor,limit:32,include_superseded:true});assert.equal(page.value.ok,true);entries.push(...page.value.entries);cursor=page.value.next_after_id} while(cursor!==null)
   assert.ok(entries.some(e=>e.kind==='error'&&e.text.includes('ORIGIN_DENIED')),'memory retrieves first error')
   assert.ok(entries.some(e=>e.kind==='decision'&&e.supersedes===first&&e.text.includes('Correction')),'memory retrieves the correction')
   const recalled=await invoke('cu_browser_recall',{event_seq:old.seq,max_chars:16000});assert.equal(recalled.value.ok,true);assert.ok(recalled.value.content_text.includes('accessibility_tree'))
   const pinned=await invoke('cu_browser_image_pins');assert.ok(pinned.value.pinned.includes(pinSeq))
   const image=await invoke('cu_browser_image_recall',{event_seq:pinSeq});assert.equal(image.value.ok,true)
   const recoveredImage=await invoke('cu_browser_image_recall',{event_seq:offloadedImage.seq});assert.equal(recoveredImage.value.ok,true,'offloaded image reissued from verified attachment')
   const events=session.snapshotEvents(),imageOffloads=events.filter(e=>e.type==='image/offload').length
   assert.ok(imageOffloads>0,'old distinct screenshots must be offloaded')
   const restored=ctx.sessions.create('long-restored-'+mode,{seed:events});assert.deepEqual(restored.deriveMessages(),session.deriveMessages())
   const prior=lab.state.submissions;await invoke('cu_browser_close');assert.equal(lab.state.submissions,prior)
   report.push({mode,compact_duplicates:compactDuplicates,observations:50,checkpoint_count:checkpoints.length,first_error_recalled:true,decision_correction:true,user_correction:true,single_save:true,pinned_image_preserved:true,pinned_image_recalled:true,offloaded_image_recalled:true,image_offloads:imageOffloads,old_observation_recalled:true,replay_equal:true,estimated_tokens_by_role:estimatedByRole,retained_ptc_duplicate_chars:retainedPtcDuplicateChars,checkpoints,model_calls:0})
  }
  assert.equal(await fingerprint(),sourceHash,'source changed during evaluation')
  for(const result of report)result.source_sha256=sourceHash
  await fs.mkdir('.artifacts',{recursive:true});await fs.writeFile(compactDuplicates?'.artifacts/long-flow-smoke-compact.json':'.artifacts/long-flow-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
 }finally{await fiber.dispose();await offloadFiber.dispose();await lab.close();await fs.rm(home,{recursive:true,force:true})}
})().then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(1)})
