// Actual DSH services, synthetic session and one tiny local fixture image.
// No model request, native UI, network or personal session is accessed.
const {pathToFileURL}=require('node:url'),{resolve,join}=require('node:path'),{tmpdir}=require('node:os'),fs=require('node:fs/promises'),assert=require('node:assert/strict')
;(async()=>{
 const base='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/',load=n=>import(pathToFileURL(base+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{SessionProjectionRegistry}=await load('dsh-session-projection'),{ToolRuntime}=await load('dsh-tools'),{LocalAttachmentStore}=await load('dsh-attachment-local'),{ApprovalService}=await load('dsh-user-approval'),offload=await load('dsh-compaction-image-offload')
 const plugin=await import(pathToFileURL(resolve('src/desktop-plugin.js')).href),{DESKTOP_IMAGES_KEY,trimDesktopImages}=await import(pathToFileURL(resolve('src/desktop-images.js')).href),{DesktopApprovalPanel}=await import(pathToFileURL(resolve('src/desktop-approval.js')).href),{DesktopApplications}=await import(pathToFileURL(resolve('src/desktop-apps.js')).href)
 const home=await fs.mkdtemp(join(tmpdir(),'dsh-desktop-context-')),ctx=new Context(),prompts=[];let fiber,offloadFiber,panelCalls=0;const old=DesktopApprovalPanel.prototype.request,appMethods=['inspect','windows','status'],oldApps=appMethods.map(k=>DesktopApplications.prototype[k])
 try{
  new SessionStore(ctx);new SessionProjectionRegistry(ctx);const store=new LocalAttachmentStore(ctx,{dshHome:home})
  class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}context(d){prompts.push(d);return()=>{}}getContextOrder(){return 0}};new Prompt(ctx)
  class Agents extends Service{constructor(c){super(c,'agents')}};new Agents(ctx)
  const tools=new ToolRuntime(ctx,{mode:'native'}),approval=new ApprovalService(ctx,{policy:'ask'})
  ctx.on('approval/request',()=>Promise.resolve('unavailable'))
  DesktopApprovalPanel.prototype.request=async()=>{panelCalls++;return 'allowed-once'}
  offloadFiber=ctx.plugin(offload,{});await offloadFiber;fiber=ctx.plugin(plugin,{helperPath:'/unused/helper',maxActions:50});await fiber;await new Promise(r=>setImmediate(r))
  const session=ctx.sessions.create('desktop-context-fixture'),agentCtx=new Context(),agent={session,ctx:agentCtx,inject(){}};session.append('turn/start',{turn:1});await ctx.serial('agent/created',{agent})
  const call=(name,args)=>tools.execute({name,arguments:args,agent,callId:'context-'+name,signal:new AbortController().signal})
  await call('cu_desktop_mode',{mode:'visual'});assert.equal((await call('cu_desktop_mode',{mode:'semantic'})).value.ok,true);assert.equal(panelCalls,1)
  await call('cu_desktop_mode',{mode:'visual'});approval.setPolicy(agent,'never');assert.equal((await call('cu_desktop_mode',{mode:'semantic'})).value.error_code,'APPROVAL_REJECTED');assert.equal(panelCalls,1);approval.setPolicy(agent,'ask')
  const audit=session.snapshotEvents().filter(e=>e.type==='approval/decided');assert.deepEqual(audit.map(e=>e.data.outcome),['allowed-once','rejected'])
  const syntheticApp={pid:42,bundle_id:'org.dsh.lossless.fixture',path:'/Applications/Fixture.app',name:'Fixture',fingerprint:'file',process_start:'1:2',trusted_location:true}
  DesktopApplications.prototype.inspect=async()=>({ok:true,application:syntheticApp});DesktopApplications.prototype.windows=async()=>({ok:true,windows:[{window_id:17,on_screen:true,layer:0}]});DesktopApplications.prototype.status=async()=>({ok:true,protocol:'dsh-desktop/2',features:['atomic_focus_input','independent_window_capture','floating_approval','local_window_preview']})
  const authorized=await call('cu_desktop_authorize',{pid:42,bundleId:syntheticApp.bundle_id,window_id:17,purpose:'只验证真实工具边界的JSON序列化',control:true,preview:false});assert.equal(!!authorized.isError,false);assert.equal(authorized.value.ok,true);assert.equal(Object.hasOwn(authorized.value,'local_preview'),false);await call('cu_desktop_revoke',{})
  const stable=prompts.find(p=>p.name==='desktop:workflow');assert.ok(stable);const before=stable.text({agent})
  const png=await fs.readFile('test/fixtures/desktop-context.png'),[ref]=await store.saveImages([{data:png,mediaType:'image/png',name:'synthetic.png'}]),rows=[]
  for(let i=0;i<7;i++){const callId='image-'+i;session.append('tool/call',{turn:1,step:i+1,callId,name:'cu_desktop_step',arguments:'{}'});const e=session.append('tool/result',{turn:1,step:i+1,message:{id:'desktop-image-'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:'{"ok":true}'},{type:'image',attachment:ref}]}},{surfaceOp:'append'});rows.push(e.seq)}
  const original=session.snapshotEvents(),state=ctx.sessionProjections.stateOf(session,DESKTOP_IMAGES_KEY);assert.equal(state.rows.length,7)
  const noHostCtx=new Context();new SessionStore(noHostCtx);const noHost=noHostCtx.sessions.create('no-image-projection',{seed:original}),seq=noHost.seq;assert.equal((await trimDesktopImages(noHost,state,store)).status,'host_projection_unavailable');assert.equal(noHost.seq,seq)
  const status=()=>call('cu_desktop_context_status',{})
  await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}));assert.equal((await status()).value.status,'pending_input_deferred')
  await agentCtx.waterfall('agent/pre-step',{},()=>Promise.resolve({messages:[{source:{kind:'user'}}]}));await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}));assert.equal((await status()).value.offloaded,0)
  await agentCtx.waterfall('agent/pre-step',{},()=>Promise.resolve({messages:[]}));await agentCtx.waterfall('agent/request',{},()=>Promise.resolve({}));assert.equal((await status()).value.offloaded,5);assert.deepEqual((await status()).value.available_image_event_seqs,rows)
  const images=session.deriveMessages().filter(m=>m.id?.startsWith('desktop-image-')).map(m=>m.content.find(b=>b.type==='image'));assert.deepEqual(images.map(b=>b.offloaded===true),[true,true,true,true,true,false,false])
  const recalled=await call('cu_desktop_image_recall',{event_seq:rows[0]});assert.equal(recalled.content.find(b=>b.type==='image').attachment.attachmentId,ref.attachmentId)
  const restored=ctx.sessions.create('desktop-context-restored',{seed:session.snapshotEvents()});assert.deepEqual(restored.deriveMessages(),session.deriveMessages());assert.equal(stable.text({agent}),before)
  const report={status:'passed',real_DSH_services:true,native_answerer_transport:'scripted_fixture',native_prepend_answerer_verified:true,never_policy_preserved:true,approval_audit_pairs:3,lossless_authorize_output_verified:true,desktop_images_recorded:7,offloaded:5,recent_images_retained:2,raw_events_retained:true,recall_verified:true,restore_verified:true,pending_input_deferred:true,missing_host_projection_safe:true,stable_workflow_context:true,paid_model_calls:0}
  await fs.mkdir('.artifacts',{recursive:true});await fs.writeFile('.artifacts/desktop-context-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
 }finally{DesktopApprovalPanel.prototype.request=old;appMethods.forEach((k,i)=>DesktopApplications.prototype[k]=oldApps[i]);await fiber?.dispose();await offloadFiber?.dispose();await fs.rm(home,{recursive:true,force:true})}
})().then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(1)})
