// Real DSH attachment store in a disposable directory; no personal profile.
const {pathToFileURL}=require('node:url'),{resolve}=require('node:path'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict')
;(async()=>{
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/'
 const load=n=>import(pathToFileURL(root+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{TokenMeter}=await load('dsh-token-meter'),{ToolRuntime}=await load('dsh-tools'),{LocalAttachmentStore}=await load('dsh-attachment-local')
 const plugin=await import(pathToFileURL(resolve('src/plugin.js')).href),fixture=JSON.parse(await fs.readFile('test/fixtures/dsh-native-assistant.json','utf8'))
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-image-recall-'));let fiber
 try{
  const ctx=new Context();new SessionStore(ctx);new SessionProjectionRegistry(ctx);new TokenMeter(ctx);const store=new LocalAttachmentStore(ctx,{dshHome:home})
  class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}};new Prompt(ctx)
  const tools=new ToolRuntime(ctx,{mode:'native'});fiber=ctx.plugin(plugin,{imagePinsEnabled:true});await fiber;await new Promise(r=>setImmediate(r))
  const source=await fs.readFile('.artifacts/eval/2026-10-27T14-52-40.940Z/long-page-find-1.png')
  const [attachment]=await store.saveImages([{data:source,mediaType:'image/png',name:'fixture.png'}])
  const session=ctx.sessions.create('image-real-store'),agent={session},id=fixture.callId
  const assistant=JSON.parse(JSON.stringify(fixture.assistant).replaceAll('cu_browser_open','cu_browser_screenshot'))
  session.append('assistant/message',assistant,{surfaceOp:'append'})
  session.append('tool/call',{turn:1,step:1,callId:id,name:'cu_browser_screenshot',arguments:'{}'})
  const event=session.append('tool/result',{turn:1,step:1,message:{id:'shot',role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content:[{type:'text',text:JSON.stringify({ok:true,accessibility_tree:'- status: fixture'})},{type:'image',attachment}]}},{surfaceOp:'append'})
  const execute=(agent,callId)=>tools.execute({callId,name:'cu_browser_image_recall',arguments:{event_seq:event.seq},agent,signal:new AbortController().signal})
  const recalled=await execute(agent,'recall-real');assert.equal(recalled.value.ok,true);assert.equal(recalled.content.find(x=>x.type==='image').attachment.attachmentId,attachment.attachmentId)
  assert.ok((await store.readImage(attachment)).data.length>0)
  const pinArgs={event_seq:event.seq,pinned:true},pinId='pin-native'
  session.append('tool/call',{turn:1,step:2,callId:pinId,name:'cu_browser_image_pin',arguments:JSON.stringify(pinArgs)})
  const pending=await tools.execute({callId:pinId,name:'cu_browser_image_pin',arguments:pinArgs,agent,signal:new AbortController().signal});assert.equal(pending.value.status,'pending_recording')
  session.append('tool/result',{turn:1,step:2,message:{id:'pin-result',role:'tool',toolCallId:pinId,source:{kind:'tool',callId:pinId},content:pending.content}},{surfaceOp:'append'})
  const readPins=agent=>tools.execute({callId:'pin-status',name:'cu_browser_image_pins',arguments:{},agent,signal:new AbortController().signal})
  assert.deepEqual((await readPins(agent)).value.pinned,[event.seq])
  const restored=ctx.sessions.create('pin-restored',{seed:session.snapshotEvents()});assert.deepEqual((await readPins({session:restored})).value.pinned,[event.seq])
  const unpin={event_seq:event.seq,pinned:false},subCallId='pin-ptc'
  session.append('tool/ptc-dispatch-start',{rootCallId:'root',parentCallId:'root',subCallId,name:'cu_browser_image_pin',arguments:unpin})
  const pendingUnpin=await tools.execute({callId:subCallId,name:'cu_browser_image_pin',arguments:unpin,agent,signal:new AbortController().signal});assert.equal(pendingUnpin.value.status,'pending_recording')
  session.append('tool/ptc-dispatch',{rootCallId:'root',parentCallId:'root',subCallId,name:'cu_browser_image_pin',arguments:unpin,isError:false,content:pendingUnpin.content})
  assert.deepEqual((await readPins(agent)).value.pinned,[])
  const isolated=await execute({session:ctx.sessions.create('other-session')},'recall-other');assert.equal(isolated.value.error_code,'IMAGE_HISTORY_NOT_FOUND')
  await fs.chmod(store.imageHostPath(attachment),0o600)
  await fs.writeFile(store.imageHostPath(attachment),Buffer.from('corrupted fixture'))
  const corrupt=await execute(agent,'recall-corrupt');assert.equal(corrupt.value.error_code,'IMAGE_ATTACHMENT_UNAVAILABLE');assert.ok(!corrupt.content.some(x=>x.type==='image'))
  session.append('tool/call',{turn:1,step:3,callId:'pin-corrupt',name:'cu_browser_image_pin',arguments:JSON.stringify(pinArgs)})
  const corruptPin=await tools.execute({callId:'pin-corrupt',name:'cu_browser_image_pin',arguments:pinArgs,agent,signal:new AbortController().signal});assert.equal(corruptPin.isError,true)
  session.append('tool/result',{turn:1,step:3,message:{id:'pin-corrupt-result',role:'tool',toolCallId:'pin-corrupt',source:{kind:'tool',callId:'pin-corrupt'},content:corruptPin.content,isError:true}},{surfaceOp:'append'})
  assert.deepEqual((await readPins(agent)).value.pinned,[],'unverified corrupt attachment cannot be pinned')
  await fs.unlink(store.imageHostPath(attachment))
  const missing=await execute(agent,'recall-missing');assert.equal(missing.value.error_code,'IMAGE_ATTACHMENT_UNAVAILABLE');assert.ok(!missing.content.some(x=>x.type==='image'))
  console.log(JSON.stringify({real_attachment_store:true,actual_image_reissued:true,cross_session_denied:true,native_pin_recorded:true,pin_restored:true,simulated_ptc_unpin:true,corrupt_attachment_detected:true,missing_attachment_detected:true,model_calls:0}))
 }finally{await fiber?.dispose();await fs.rm(home,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack);process.exitCode=1})
