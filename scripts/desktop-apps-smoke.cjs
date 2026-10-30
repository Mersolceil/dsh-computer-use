// Real DSH approval/tool runtime and native lifecycle of one disposable app.
// Synthetic approval answers only; no model, network or personal application.
const {pathToFileURL}=require('node:url'),{resolve,join}=require('node:path'),{tmpdir}=require('node:os'),fs=require('node:fs/promises'),{spawnSync}=require('node:child_process'),assert=require('node:assert/strict')
;(async()=>{
 const root='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/',load=n=>import(pathToFileURL(root+n+'/lib/index.js').href)
 const {Context,Service}=await load('cordis'),{SessionStore}=await load('dsh-session'),{ToolRuntime}=await load('dsh-tools'),{ApprovalService}=await load('dsh-user-approval')
 const plugin=await import(pathToFileURL(resolve('src/desktop-plugin.js')).href),{DesktopApplications}=await import(pathToFileURL(resolve('src/desktop-apps.js')).href)
 const helper=resolve(process.argv[2]??'.artifacts/desktop-control-helper-v5/DSHDesktopHelper.app/Contents/MacOS/DSHDesktopHelper'),dir=await fs.mkdtemp(join(tmpdir(),'dsh-app-lifecycle-')),app=join(dir,'Fixture.app'),contents=join(app,'Contents'),bundle='org.dsh.lifecycle.fixture',marker=join(dir,'allow-quit')
 let fiber,pid
 try{
  await fs.mkdir(join(contents,'MacOS'),{recursive:true})
  const source=join(dir,'main.swift');await fs.writeFile(source,`import AppKit\nfinal class Delegate:NSObject,NSApplicationDelegate { func applicationShouldTerminate(_ app:NSApplication)->NSApplication.TerminateReply { return FileManager.default.fileExists(atPath:${JSON.stringify(marker)}) ? .terminateNow : .terminateCancel } }\nlet app=NSApplication.shared\napp.setActivationPolicy(.accessory)\nlet delegate=Delegate()\napp.delegate=delegate\napp.run()\n`)
  const build=spawnSync('swiftc',['-module-cache-path',join(tmpdir(),'dsh-cu-fixture-swift-cache'),source,'-o',join(contents,'MacOS','Fixture')],{encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr)
  await fs.writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Lifecycle Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  const ctx=new Context();new SessionStore(ctx)
  class Prompt extends Service{constructor(c){super(c,'systemPrompt')}tools(){return()=>{}}context(){return()=>{}}getContextOrder(){return 0}};new Prompt(ctx)
  class Images extends Service{constructor(c){super(c,'attachments')}async saveImages(){throw Error('Lifecycle-only smoke must not capture images')}};new Images(ctx)
  const tools=new ToolRuntime(ctx,{mode:'native'});new ApprovalService(ctx,{policy:'ask'});let answer='rejected';ctx.on('approval/request',()=>answer)
  fiber=ctx.plugin(plugin,{helperPath:helper,maxActions:15});await fiber;await new Promise(r=>setImmediate(r))
  const session=ctx.sessions.create('application-lifecycle-smoke'),agent={session};session.append('turn/start',{turn:1});let count=0
  async function call(name,args){const result=await tools.execute({name:'cu_desktop_'+name,arguments:args,callId:'local-'+(++count),agent,signal:new AbortController().signal});assert.equal(!!result.isError,false,JSON.stringify(result));return result.value}
  assert.equal((await call('open',{application:app})).error_code,'APPROVAL_REJECTED')
  answer='allowed-once';const opened=await call('open',{application:app});assert.equal(opened.ok,true,JSON.stringify(opened));pid=opened.application.pid;assert.equal(opened.activation_requested,false)
  const manager=new DesktopApplications({helperPath:helper}),target=opened.application
  const changed=await manager.quit({...target,process_start:'1:1'});assert.equal(changed.error_code,'TARGET_CHANGED')
  answer='rejected';assert.equal((await call('quit',{pid,bundleId:bundle})).error_code,'APPROVAL_REJECTED');assert.equal((await manager.inspect(pid,bundle)).ok,true)
  answer='allowed-once';const veto=await call('quit',{pid,bundleId:bundle});assert.equal(veto.closed,false);assert.equal(veto.requires_user_attention,true);assert.equal((await manager.inspect(pid,bundle)).ok,true)
  await fs.writeFile(marker,'allow');const quit=await call('quit',{pid,bundleId:bundle});assert.equal(quit.closed,true,JSON.stringify(quit));assert.equal((await manager.inspect(pid,bundle)).ok,false);pid=undefined
  const events=session.snapshotEvents(),asked=events.filter(e=>e.type==='approval/asked'),decided=events.filter(e=>e.type==='approval/decided');assert.equal(asked.length,5);assert.equal(decided.length,5);assert.equal(new Set(asked.map(e=>e.data.id)).size,5)
  session.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const report={status:'passed',model_calls:0,tool_calls:count,real_dsh_approval_audit_pairs:asked.length,denied_open_and_quit:true,background_launch:true,process_identity_checked:true,quit_veto_preserved:true,normal_exit_verified:true,personal_apps_accessed:false}
  await fs.mkdir('.artifacts',{recursive:true});await fs.writeFile('.artifacts/desktop-apps-smoke.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
 }finally{await fiber?.dispose();if(pid){await fs.writeFile(marker,'allow');const manager=new DesktopApplications({helperPath:helper}),current=await manager.inspect(pid,bundle);if(current.ok)await manager.quit(current.application)}await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack);process.exitCode=1})
