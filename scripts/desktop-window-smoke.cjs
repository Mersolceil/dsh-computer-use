// One real OS-window image through actual DSH tools, approval and durable image
// attachment services. Only a disposable fixture; no model or personal window.
const {pathToFileURL}=require('node:url'),{resolve,join}=require('node:path'),{tmpdir}=require('node:os'),fs=require('node:fs/promises'),{spawn,spawnSync}=require('node:child_process'),assert=require('node:assert/strict')
;(async()=>{
 const sdk='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/',load=n=>import(pathToFileURL(sdk+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{ToolRuntime}=await load('dsh-tools'),{ApprovalService}=await load('dsh-user-approval'),{LocalAttachmentStore}=await load('dsh-attachment-local')
 const plugin=await import(pathToFileURL(resolve('src/desktop-plugin.js')).href),{DesktopApplications}=await import(pathToFileURL(resolve('src/desktop-apps.js')).href)
 const helper=resolve(process.argv[2]||'.artifacts/desktop-control-helper-v6-final/DSHDesktopHelper.app/Contents/MacOS/DSHDesktopHelper'),dir=await fs.mkdtemp(join(tmpdir(),'dsh-real-window-')),app=join(dir,'Fixture.app'),contents=join(app,'Contents'),bundle='org.dsh.fixture.capture'
 const manager=new DesktopApplications({helperPath:helper});let target,fiber,ctx,child
 try{
  await fs.mkdir(join(contents,'MacOS'),{recursive:true});const build=spawnSync('swiftc',['-module-cache-path',join(tmpdir(),'dsh-cu-fixture-swift-cache'),resolve('native/macos/fixture.swift'),'-o',join(contents,'MacOS/Fixture')],{encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr)
  await fs.writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Screenshot Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  // Wait for the actual AppKit window, not merely a launch-services process.
  // A live application can also own a hidden 500x500 internal window.
  child=spawn(join(contents,'MacOS/Fixture'),[],{stdio:['ignore','pipe','ignore']});let stdout=''
  await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture readiness timeout')),5000);child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('READY\n')){clearTimeout(timer);accept()}});child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture exited before ready'))})})
  const inspected=await manager.inspect(child.pid,bundle);assert.equal(inspected.ok,true,JSON.stringify(inspected));target=inspected.application;assert.equal(target.path,app)
  ctx=new Context();new SessionStore(ctx);new LocalAttachmentStore(ctx,{dshHome:join(dir,'isolated-home')})
  class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}context(){return()=>{}}getContextOrder(){return 0}};new Prompt(ctx)
  const tools=new ToolRuntime(ctx,{mode:'native'});new ApprovalService(ctx,{policy:'ask'});let approvals=0;ctx.on('approval/request',()=>{approvals++;return 'allowed-once'})
  fiber=ctx.plugin(plugin,{helperPath:helper,maxActions:10});await fiber;await new Promise(r=>setImmediate(r))
  const session=ctx.sessions.create('real-window-screenshot'),agent={session};session.append('turn/start',{turn:1});let calls=0
  async function call(name,args){const result=await tools.execute({name:'cu_desktop_'+name,arguments:args,callId:'window-'+(++calls),agent,signal:new AbortController().signal});assert.equal(!!result.isError,false,JSON.stringify(result));return result}
  const attached=await call('attach',{pid:target.pid,bundleId:bundle}),listing=await call('windows',{pid:target.pid,bundleId:bundle});assert.equal(listing.value.ok,true,JSON.stringify(listing));assert.ok(listing.value.windows.length,'The synthetic fixture must expose a real window')
  const flatten=nodes=>(nodes??[]).flatMap(n=>[n,...flatten(n.children)]),axContent=attached.value.ok&&flatten(attached.value.windows).some(n=>n.role==='AXStaticText'&&n.text==='Saved: 0')
  const frame=stdout.match(/FRAME:([\d.]+),([\d.]+)/),selected=listing.value.windows.find(w=>w.on_screen===true&&w.bounds?.Width===Number(frame?.[1])&&w.bounds?.Height===Number(frame?.[2]));assert.ok(selected,'Select the ready fixture window by its real frame; never an internal hidden placeholder')
  const picture=await call('screenshot',{pid:target.pid,bundleId:bundle,window_id:selected.window_id});assert.equal(picture.value.ok,true,JSON.stringify(picture.value));assert.equal(picture.value.capture_source,'macos-window');assert.ok(picture.content.some(b=>b.type==='image'));assert.ok(!picture.content.some(b=>b.type==='text'&&b.text.includes('iVBOR')))
  const ref=picture.value.image_attachment;await ctx.attachments.readImage(ref);const bytes=await fs.readFile(await ctx.attachments.imageHostPath(ref));assert.ok(['image/png','image/jpeg','image/webp'].includes(ref.mediaType));assert.ok(ref.width>200&&ref.height>100);await fs.mkdir('.artifacts',{recursive:true});const extension=ref.mediaType==='image/png'?'png':ref.mediaType==='image/jpeg'?'jpg':'webp';await fs.writeFile('.artifacts/desktop-window-smoke.'+extension,bytes)
  await call('close',{});assert.equal((await manager.inspect(target.pid,bundle)).ok,true)
  const events=session.snapshotEvents(),audit=events.filter(e=>e.type==='approval/decided');assert.equal(approvals,1);assert.equal(audit.length,1);assert.equal(audit[0].data.outcome,'allowed-once')
  const report={status:axContent?'passed':'partial',real_os_window_capture:true,real_dsh_tool_runtime:true,real_dsh_attachment_store:true,approval_audit_pairs:audit.length,ax_tree_read:axContent,ax_error:attached.value.error_code??(axContent?null:'FIXTURE_CONTENT_NOT_EXPOSED'),selected_window: selected,width:ref.width,height:ref.height,image_file:'.artifacts/desktop-window-smoke.'+extension,tool_calls:calls,model_calls:0,personal_windows_captured:false,DSH_restarted:false}
  await fs.writeFile('.artifacts/desktop-window-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!axContent)process.exitCode=1
 }finally{await fiber?.dispose();if(target){await manager.quit(target);const remaining=await manager.inspect(target.pid,bundle);if(remaining.ok&&remaining.application.process_start===target.process_start)process.kill(target.pid,'SIGTERM')}else child?.kill('SIGTERM');await fs.rm(dir,{recursive:true,force:true})}
})().then(()=>process.exit(process.exitCode??0),e=>{console.error(e.stack);process.exit(1)})
