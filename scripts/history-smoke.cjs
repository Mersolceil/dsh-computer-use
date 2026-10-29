// Actual installed Session/Projection/TokenMeter/ToolRuntime contract test.
// No personal profiles or model credentials are read or changed.
const {pathToFileURL}=require('node:url'),{resolve,join}=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict')
;(async()=>{
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/'
 const load=n=>import(pathToFileURL(root+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore,Session}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{TokenMeter}=await load('dsh-token-meter'),{ToolRuntime}=await load('dsh-tools')
 const imageOffload=await load('dsh-compaction-image-offload')
 const plugin=await import(pathToFileURL(resolve('src/plugin.js')).href),{HISTORY_KEY}=await import(pathToFileURL(resolve('src/history.js')).href),{STATE_KEY}=await import(pathToFileURL(resolve('src/task-state.js')).href)
 const fixture=JSON.parse(await fs.readFile('test/fixtures/dsh-native-assistant.json','utf8'))
 const ctx=new Context();new SessionStore(ctx);new SessionProjectionRegistry(ctx);new TokenMeter(ctx)
 class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}};new Prompt(ctx)
 class Agents extends Service{constructor(c){super(c,'agents')}};new Agents(ctx)
 class Images extends Service{constructor(c){super(c,'attachments')}async saveImages(){return[]}async readImage(ref){if(ref.attachmentId!=='sha256:image-0')throw Error('missing fixture');return Buffer.from('fixture')}};new Images(ctx)
 const imageOffloadFiber=ctx.plugin(imageOffload,{});await imageOffloadFiber
 const tools=new ToolRuntime(ctx,{mode:'native'});const fiber=ctx.plugin(plugin,{historyKeepRecent:4,taskStateEnabled:true,ptcHistoryEnabled:true});await fiber
 // Wait for optional dependency injection through its documented awaitable effect.
 await new Promise(r=>setImmediate(r));assert.ok(tools.schemas().some(t=>t.name==='cu_browser_recall'),'optional history services mounted')
 const session=ctx.sessions.create('history-smoke');const template=JSON.stringify(fixture.assistant),old=fixture.callId
 for(let i=0;i<50;i++){
  const callId='history-'+i;const data=JSON.parse(template.replaceAll(old,callId));data.step=i+1;data.message.id='assistant-'+i
  session.append('assistant/message',data,{surfaceOp:'append'})
  session.append('tool/call',{turn:1,step:i+1,callId,name:'cu_browser_open',arguments:'{"url":"http://127.0.0.1:4173"}'})
  const value={ok:true,observation_id:'obs_'+i,accessibility_tree:'- status: evidence '+i+'\n'+'x'.repeat(12000),url:'http://127.0.0.1:4173/',...(i===0?{ok:false,error_code:'FIRST_ERROR',message:'original failure',result_uncertain:true}:{})}
  session.append('tool/result',{turn:1,step:i+1,message:{id:'result-'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify(value)}]}},{surfaceOp:'append'})
 }
 const nonToolBefore=session.deriveMessages().filter(m=>m.role!=='tool')
 const before=JSON.stringify(session.deriveMessages()).length
 const agentCtx=new Context(),agent={ctx:agentCtx,session};await ctx.serial('agent/created',{agent})
 await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({provider:'fixture',model:'fixture'}))
 const messages=session.deriveMessages(),after=JSON.stringify(messages).length,state=ctx.sessionProjections.stateOf(session,HISTORY_KEY)
 const stateMessages=messages.filter(m=>m.source?.kind==='computer-use-state')
 assert.equal(stateMessages.length,1,'one task-state snapshot is visible')
 assert.deepEqual(messages.filter(m=>m.role!=='tool'&&m.source?.kind!=='computer-use-state'),nonToolBefore,'original non-tool messages remain exact')
 const values=messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content[0].text))
 assert.equal(values.filter(v=>v.accessibility_tree).length,5);assert.ok(values.some(v=>v.error_code==='FIRST_ERROR'));assert.ok(after<before/4)
 const recall=await tools.execute({callId:'recall',name:'cu_browser_recall',arguments:{event_seq:state.rows[1].seq,max_chars:16000},agent,signal:new AbortController().signal})
 assert.ok(!recall.isError&&recall.value.content_text.includes('evidence 1'),'recall original removed tree through real tool pipeline')
 const snapshot=session.snapshotEvents();const replay=new Session('history-replay',snapshot);assert.deepEqual(replay.deriveMessages(),messages,'surface replacement replays deterministically')
 const restored=ctx.sessions.create('history-restored',{seed:snapshot});const restoredState=ctx.sessionProjections.stateOf(restored,HISTORY_KEY);assert.equal(restoredState.rows.length,50,'archived originals rebuild from durable events');const restoredRead=await tools.execute({callId:'restore-read',name:'cu_browser_recall',arguments:{event_seq:state.rows[1].seq},agent:{session:restored},signal:new AbortController().signal});assert.ok(restoredRead.value.content_text.includes('evidence 1'))
 await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}));assert.equal(session.seq,snapshot.length,'second request is idempotent')
 const other=ctx.sessions.create('history-other');const denied=await tools.execute({callId:'other',name:'cu_browser_recall',arguments:{event_seq:state.rows[1].seq},agent:{session:other},signal:new AbortController().signal});assert.equal(denied.value.error_code,'HISTORY_NOT_FOUND')
 // Real host state projection must replace its own previous message as the
 // ledger advances, preserve the user's original messages, and replay exactly.
 const evolving=ctx.sessions.create('state-evolution'),evolvingCtx=new Context(),evolvingAgent={ctx:evolvingCtx,session:evolving}
 await ctx.serial('agent/created',{agent:evolvingAgent})
 const userMessage=(id,text)=>({id,role:'user',source:{kind:'user'},content:[{type:'text',text}]})
 evolving.append('user/message',userMessage('user-1','Save only once'),{surfaceOp:'append'})
 await evolvingCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 evolving.append('user/message',userMessage('user-2','Keep the original error'),{surfaceOp:'append'})
 await evolvingCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 evolving.append('user/message',userMessage('user-3','Continue from the current step'),{surfaceOp:'append'})
 await evolvingCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 const evolvedMessages=evolving.deriveMessages(),states=evolvedMessages.filter(m=>m.source?.kind==='computer-use-state')
 assert.equal(states.length,1,'state snapshot is replaced instead of accumulating')
 const evolved=JSON.parse(states[0].content[0].text)
 assert.equal(evolved.summary.revision,3)
 assert.match(evolved.summary.user_intent.first.text,/Save only once/)
 assert.match(evolved.summary.user_intent.latest.text,/Continue from the current step/)
 assert.ok(evolved.summary.user_intent.recent.some(e=>e.text.includes('Keep the original error')))
 assert.equal(evolved.summary.user_intent.omitted,0)
 assert.equal(evolvedMessages.filter(m=>m.source?.kind==='user').length,3)
 assert.deepEqual(new Session('state-replay',evolving.snapshotEvents()).deriveMessages(),evolvedMessages)
 evolving.append('user/message',userMessage('user-4','Check before saving'),{surfaceOp:'append'})
 const append=evolving.append.bind(evolving);let injectFailure=true
 evolving.append=(type,data,options)=>{
  if(injectFailure&&type==='user/message'&&data.source?.kind==='computer-use-state'&&options?.surfaceOp?.op==='replace') {injectFailure=false;throw Error('injected snapshot failure')}
  return append(type,data,options)
 }
 await assert.rejects(evolvingCtx.waterfall('agent/request',{},()=>Promise.resolve({})),/injected snapshot failure/)
 const failedState=ctx.sessionProjections.stateOf(evolving,STATE_KEY)
 assert.equal(failedState.rollup.anchor,3,'failed replacement must not advance the anchor')
 assert.equal(failedState.priced,true,'successful prune is recorded for retry')
 const countPrunes=()=>evolving.snapshotEvents().filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs?.includes(failedState.seq)).length
 assert.equal(countPrunes(),1)
 evolving.append=append
 await evolvingCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 assert.equal(ctx.sessionProjections.stateOf(evolving,STATE_KEY).rollup.anchor,4)
 assert.equal(countPrunes(),1,'retry must not charge the same snapshot again')
 const retried=evolving.deriveMessages()
 assert.equal(retried.filter(m=>m.source?.kind==='computer-use-state').length,1)
 assert.deepEqual(new Session('state-retry-replay',evolving.snapshotEvents()).deriveMessages(),retried)
 // Inject failure between a real prune event and a browser tool replacement.
 const recovery=ctx.sessions.create('history-recovery'),recoveryCtx=new Context(),recoveryAgent={ctx:recoveryCtx,session:recovery}
 await ctx.serial('agent/created',{agent:recoveryAgent})
 for(let i=0;i<6;i++){
  const callId='recovery-'+i,data=JSON.parse(template.replaceAll(old,callId));data.step=i+1;data.message.id='recovery-assistant-'+i
  recovery.append('assistant/message',data,{surfaceOp:'append'})
  recovery.append('tool/call',{turn:1,step:i+1,callId,name:'cu_browser_observe',arguments:'{}'})
  recovery.append('tool/result',{turn:1,step:i+1,message:{id:'recovery-result-'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify({ok:true,accessibility_tree:'- status: recovered '+i+'\n'+'x'.repeat(12000)})}]}},{surfaceOp:'append'})
 }
 const firstRecovery=ctx.sessionProjections.stateOf(recovery,HISTORY_KEY).rows[0].seq
 const appendRecovery=recovery.append.bind(recovery);let failHistory=true
 recovery.append=(type,data,options)=>{
  if(failHistory&&type==='tool/result'&&options?.surfaceOp?.op==='replace'){failHistory=false;throw Error('injected history failure')}
  return appendRecovery(type,data,options)
 }
 await assert.rejects(recoveryCtx.waterfall('agent/request',{},()=>Promise.resolve({})),/injected history failure/)
 assert.ok(recovery.surface.nodes.includes(firstRecovery),'original observation survives failed replacement')
 assert.ok(ctx.sessionProjections.stateOf(recovery,HISTORY_KEY).priced.includes(firstRecovery))
 const historyPrunes=()=>recovery.snapshotEvents().filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs?.includes(firstRecovery)).length
 assert.equal(historyPrunes(),1)
 const recoveryRestored=ctx.sessions.create('history-failed-restored',{seed:recovery.snapshotEvents()})
 assert.ok(ctx.sessionProjections.stateOf(recoveryRestored,HISTORY_KEY).priced.includes(firstRecovery),'committed prune survives restore')
 const restoreCtx=new Context(),restoreAgent={ctx:restoreCtx,session:recoveryRestored}
 await ctx.serial('agent/created',{agent:restoreAgent})
 await restoreCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 assert.equal(recoveryRestored.snapshotEvents().filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs?.includes(firstRecovery)).length,1,'restored retry does not duplicate accounting')
 assert.ok(!recoveryRestored.surface.nodes.includes(firstRecovery))
 recovery.append=appendRecovery
 await recoveryCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 assert.equal(historyPrunes(),1,'browser history retry does not duplicate accounting')
 assert.ok(!recovery.surface.nodes.includes(firstRecovery),'retry replaced the original observation')
 assert.deepEqual(new Session('history-retry-replay',recovery.snapshotEvents()).deriveMessages(),recovery.deriveMessages())
 const ptc=ctx.sessions.create('ptc-history'),ptcCtx=new Context(),ptcAgent={ctx:ptcCtx,session:ptc}
 await ctx.serial('agent/created',{agent:ptcAgent})
 for(let i=0;i<6;i++){
  const callId='ptc-'+i,data=JSON.parse(template.replaceAll(old,callId).replaceAll('cu_browser_open','run_code'));data.step=i+1;data.message.id='ptc-assistant-'+i
  ptc.append('assistant/message',data,{surfaceOp:'append'})
  ptc.append('tool/call',{turn:1,step:i+1,callId,name:'run_code',arguments:'{}'})
  const subCallId=callId+':ptc:1',outcome={ok:true,observation_id:'ptc-obs-'+i,accessibility_tree:'- status: ptc evidence '+i+'\n'+'x'.repeat(12000),history:{can_back:true}}
  ptc.append('tool/ptc-dispatch-start',{rootCallId:callId,parentCallId:callId,subCallId,name:'cu_browser_observe',arguments:{}})
  ptc.append('tool/ptc-dispatch',{rootCallId:callId,parentCallId:callId,subCallId,name:'cu_browser_observe',arguments:{},isError:false,content:[{type:'text',text:JSON.stringify(outcome)}]})
  ptc.append('tool/result',{turn:1,step:i+1,message:{id:'ptc-result-'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify(outcome)}]}},{surfaceOp:'append'})
 }
 const ptcImage={type:'image',attachment:{attachmentId:'sha256:fixture',mediaType:'image/png',width:10,height:10,bytes:20,name:'fixture.png'}}
 const deferredImage={id:'ptc-image-context',role:'user',source:{kind:'ptc-mode'},content:[{type:'text',text:'historical image context'},ptcImage]}
 ptc.append('user/message',deferredImage,{surfaceOp:'append'})
 const ptcState=ctx.sessionProjections.stateOf(ptc,HISTORY_KEY);assert.equal(ptcState.rows.length,6)
 const ptcFirst=ptcState.rows[0].seq,appendPtc=ptc.append.bind(ptc);let failPtc=true
 ptc.append=(type,data,options)=>{
  if(failPtc&&type==='tool/result'&&options?.surfaceOp?.op==='replace'){failPtc=false;throw Error('injected ptc replacement failure')}
  return appendPtc(type,data,options)
 }
 await assert.rejects(ptcCtx.waterfall('agent/request',{},()=>Promise.resolve({})),/injected ptc replacement failure/)
 assert.ok(ptc.surface.nodes.includes(ptcFirst));assert.ok(ctx.sessionProjections.stateOf(ptc,HISTORY_KEY).priced.includes(ptcFirst))
 const ptcRestored=ctx.sessions.create('ptc-failed-restored',{seed:ptc.snapshotEvents()}),ptcRestoreCtx=new Context(),ptcRestoreAgent={ctx:ptcRestoreCtx,session:ptcRestored}
 await ctx.serial('agent/created',{agent:ptcRestoreAgent})
 await ptcRestoreCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 assert.equal(ptcRestored.snapshotEvents().filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs?.includes(ptcFirst)).length,1)
 assert.ok(!ptcRestored.surface.nodes.includes(ptcFirst),'restored PTC retry replaces original')
 assert.deepEqual(new Session('ptc-restored-replay',ptcRestored.snapshotEvents()).deriveMessages(),ptcRestored.deriveMessages())
 ptc.append=appendPtc
 await ptcCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 assert.equal(ptc.snapshotEvents().filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs?.includes(ptcFirst)).length,1)
 const ptcMessages=ptc.deriveMessages().filter(m=>m.role==='tool'),ptcValues=ptcMessages.map(m=>JSON.parse(m.content[0].text))
 assert.deepEqual(ptc.deriveMessages().find(m=>m.id==='ptc-image-context'),deferredImage,'PTC deferred image context is untouched')
 assert.equal(ptcValues.filter(v=>v.computer_use_history).length,2)
 assert.equal(ptcValues.filter(v=>v.accessibility_tree).length,4)
 assert.deepEqual(ptcValues[0].history,{can_back:true})
 const ptcRecall=await tools.execute({callId:'ptc-recall',name:'cu_browser_recall',arguments:{event_seq:ptcState.rows[0].seq,max_chars:16000},agent:ptcAgent,signal:new AbortController().signal})
 assert.ok(ptcRecall.value.content_text.includes('ptc evidence 0'))
 assert.deepEqual(new Session('ptc-history-replay',ptc.snapshotEvents()).deriveMessages(),ptc.deriveMessages())
 const imageSession=ctx.sessions.create('ptc-image-history'),imageCtx=new Context(),imageAgent={ctx:imageCtx,session:imageSession}
 await ctx.serial('agent/created',{agent:imageAgent})
 for(let i=0;i<6;i++){
  const callId='ptc-image-'+i,data=JSON.parse(template.replaceAll(old,callId).replaceAll('cu_browser_open','run_code'));data.step=i+1;data.message.id='image-assistant-'+i
  imageSession.append('assistant/message',data,{surfaceOp:'append'})
  imageSession.append('tool/call',{turn:1,step:i+1,callId,name:'run_code',arguments:'{}'})
  const subCallId=callId+':ptc:1',outcome={ok:true,observation_id:'image-obs-'+i,accessibility_tree:'- status: image evidence '+i+'\n'+'x'.repeat(12000)}
  const image={type:'image',attachment:{attachmentId:'sha256:image-'+i,mediaType:'image/png',width:10,height:10,bytes:20,name:'fixture.png'}},content=[{type:'text',text:JSON.stringify(outcome)},image]
  imageSession.append('tool/ptc-dispatch-start',{rootCallId:callId,parentCallId:callId,subCallId,name:'cu_browser_screenshot',arguments:{}})
  imageSession.append('tool/ptc-dispatch',{rootCallId:callId,parentCallId:callId,subCallId,name:'cu_browser_screenshot',arguments:{},isError:false,content})
  imageSession.append('tool/result',{turn:1,step:i+1,message:{id:'image-result-'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify(outcome)}]}},{surfaceOp:'append'})
  imageSession.append('user/message',{id:'image-context-'+i,role:'user',source:{kind:'ptc-mode'},content},{surfaceOp:'append'})
 }
 const imageState=ctx.sessionProjections.stateOf(imageSession,HISTORY_KEY),imageRow=imageState.rows.find(r=>r.mode==='ptc-image')
 assert.equal(imageState.rows.filter(r=>r.mode==='ptc-image').length,6)
 imageSession.append('image/offload',{targets:[{seq:imageRow.seq,imageIndexes:[0]}]})
 await imageCtx.waterfall('agent/request',{},()=>Promise.resolve({}))
 const imageMessages=imageSession.deriveMessages().filter(m=>m.source?.kind==='ptc-mode')
 assert.equal(imageMessages.length,6);assert.equal(imageMessages.filter(m=>JSON.parse(m.content[0].text).computer_use_history).length,4)
 assert.ok(imageMessages.every(m=>m.content.some(b=>b.type==='image')),'all actual image attachments remain')
 assert.equal(imageMessages[0].content.find(b=>b.type==='image').offloaded,true,'existing image offload survives text replacement')
 const imageRecall=await tools.execute({callId:'image-recall',name:'cu_browser_recall',arguments:{event_seq:imageRow.seq,max_chars:16000},agent:imageAgent,signal:new AbortController().signal})
 assert.ok(imageRecall.value.content_text.includes('image evidence 0'))
 const imageAgain=await tools.execute({callId:'image-reissue',name:'cu_browser_image_recall',arguments:{event_seq:imageRow.seq},agent:imageAgent,signal:new AbortController().signal})
 assert.equal(imageAgain.value.ok,true);assert.equal(imageAgain.content.find(b=>b.type==='image')?.attachment.attachmentId,'sha256:image-0')
 assert.equal(imageAgain.content.find(b=>b.type==='image')?.offloaded,undefined,'recall deliberately reissues the original image')
 const imageDenied=await tools.execute({callId:'image-denied',name:'cu_browser_image_recall',arguments:{event_seq:imageRow.seq},agent:{session:other},signal:new AbortController().signal})
 assert.equal(imageDenied.value.error_code,'IMAGE_HISTORY_NOT_FOUND');assert.ok(!imageDenied.content.some(b=>b.type==='image'))
 const missingImageRow=imageState.rows.filter(r=>r.mode==='ptc-image')[1]
 const imageMissing=await tools.execute({callId:'image-missing',name:'cu_browser_image_recall',arguments:{event_seq:missingImageRow.seq},agent:imageAgent,signal:new AbortController().signal})
 assert.equal(imageMissing.value.error_code,'IMAGE_ATTACHMENT_UNAVAILABLE');assert.ok(!imageMissing.content.some(b=>b.type==='image'))
 const imageRestored=ctx.sessions.create('ptc-image-replay',{seed:imageSession.snapshotEvents()})
 assert.deepEqual(imageRestored.deriveMessages(),imageSession.deriveMessages())
 await fiber.dispose();assert.ok(!tools.schemas().some(t=>t.name.startsWith('cu_browser_')))
 await imageOffloadFiber.dispose()
 // The agent-scoped hook must also be removed when the plugin unloads.
 await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}));assert.equal(session.seq,snapshot.length)
 const report={date:new Date().toISOString(),steps:50,retained_full_observations:5,protected_error:1,replaced_observations:45,before_message_json_chars:before,after_message_json_chars:after,recall_passed:true,cross_session_denied:true,replay_equal:true,restored_recall:true,idempotent:true,user_constraints_snapshot:true,snapshot_replace_failure_retry:true,snapshot_retry_replay:true,history_replace_failure_retry:true,history_retry_restore:true,history_retry_replay:true,ptc_simulated_dispatch_retention:true,ptc_recall:true,ptc_replay:true,ptc_failure_retry_restore:true,ptc_deferred_image_preserved:true,ptc_image_text_dedup_recall_replay:true,image_reissue_and_isolation:true,unload_cleanup:true,model_calls:0,note:'Real installed DSH Session, projections, meter, tools and request hook. Synthetic tool history, simulated PTC dispatch and injected failure, not model success rate. Character counts, not provider tokens.'}
 await fs.writeFile('.artifacts/history-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
})().catch(e=>{console.error(e.stack);process.exitCode=1})
