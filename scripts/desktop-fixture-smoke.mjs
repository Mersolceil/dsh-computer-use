// macOS-only isolated fixture; no personal applications, profiles or Chrome.
// Exit 2 means macOS accessibility permission was unavailable, not a pass.
import { mkdtemp, mkdir, rm, writeFile,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createDesktopObserver } from '../src/desktop-observer.js'
import { DesktopSession } from '../src/desktop-session.js'
import assert from 'node:assert/strict'
import { desktopDshRun } from './desktop-dsh-run.mjs'

if (process.platform !== 'darwin') throw Error('macOS required')
const dir = await mkdtemp(join(tmpdir(), 'dsh-cu-fixture-'))
const appDir = join(dir, 'DSHFixture.app', 'Contents')
let child
let fixturePid,poll
let controlSession
const control=process.argv.includes('--control')
const dsh=process.argv.includes('--dsh-fixture')||process.argv.includes('--dsh-real')
const staleLabel=process.argv.includes('--stale-label')
const launchServices=process.argv.includes('--launch-services')
try {
  await mkdir(join(appDir, 'MacOS'), {recursive:true})
  const cache=join(tmpdir(),'dsh-cu-fixture-swift-cache'), fixture=join(appDir,'MacOS','DSHFixture'), helper=process.env.DSH_CU_DESKTOP_HELPER||(control?resolve('.artifacts/desktop-control-helper/DSHDesktopHelper.app/Contents/MacOS/DSHDesktopHelper'):join(dir,'observe'))
  const compile=(source,output)=>{
    const result=spawnSync('swiftc',['-module-cache-path',cache,resolve(source),'-o',output],{encoding:'utf8',timeout:90000})
    if(result.status!==0)throw Error(`Fixture compilation failed: ${result.error?.message??result.stderr}`)
  }
  compile('native/macos/fixture.swift',fixture)
  if(!process.env.DSH_CU_DESKTOP_HELPER&&!control)compile('native/macos/observe.swift',helper)
  await writeFile(join(appDir,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.dsh.fixture</string><key>CFBundleExecutable</key><string>DSHFixture</string><key>CFBundleName</key><string>DSH Test Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
  const fixtureArgs=staleLabel?['--rename-trigger',join(dir,'rename')]:[]
  const stdoutFile=join(dir,'stdout.txt'),stderrFile=join(dir,'stderr.txt')
  if(launchServices){
    await writeFile(stdoutFile,'');await writeFile(stderrFile,'')
    child=spawn('/usr/bin/open',['-g','-n','-W','-o',stdoutFile,'--stderr',stderrFile,join(dir,'DSHFixture.app'),'--args',...fixtureArgs],{stdio:['ignore','pipe','pipe']})
  } else {child=spawn(fixture,fixtureArgs,{stdio:['ignore','pipe','pipe']});fixturePid=child.pid}
  let stdout='',stderr=''
  child.stderr.setEncoding('utf8');child.stderr.on('data',data=>{stderr+=data;stderr=stderr.slice(-4096)})
  await new Promise((accept,reject)=>{
    const timer=setTimeout(()=>reject(Error('Fixture did not become ready')),15000)
    child.stdout.setEncoding('utf8')
    const ready=()=>{if(stdout.includes('READY\n')){fixturePid=Number(stdout.match(/PID:(\d+)/)?.[1]??fixturePid);clearTimeout(timer);accept()}}
    child.stdout.on('data',data=>{if(!launchServices){stdout+=data;ready()}})
    if(launchServices)poll=setInterval(async()=>{try{stdout=await readFile(stdoutFile,'utf8');ready()}catch{}},30)
    child.once('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`Fixture exited early (${code}): ${stderr}`))})
  })
  const observer=createDesktopObserver({helperPath:helper,allowedBundleIds:['org.dsh.fixture']})
  if(dsh){
    const dshResult=await desktopDshRun({dir,pid:fixturePid,helper,real:process.argv.includes('--dsh-real')})
    const saved=stdout.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}}).filter(e=>e.event==='saved')
    const passed=dshResult.exit===0&&dshResult.desktop_tool_calls>=5&&dshResult.tool_errors===0&&dshResult.attached&&dshResult.detached&&dshResult.observed_saved_status&&dshResult.save_calls===1&&saved.length===1&&saved[0].count===1&&saved[0].title==='DSH桌面验收'
    const report={status:passed?'passed':'failed',real_ax_control:true,dsh:dshResult,single_save:saved.length===1&&saved[0].count===1}
    await mkdir(resolve('.artifacts/desktop-eval'),{recursive:true})
    await writeFile(resolve('.artifacts/desktop-eval',Date.now()+'.json'),JSON.stringify(report,null,2))
    console.log(JSON.stringify(report));if(!passed)process.exitCode=1
  } else {
  if(control)controlSession=new DesktopSession({helperPath:helper,allowedBundleIds:['org.dsh.fixture']})
  const result=control?await controlSession.attach({pid:fixturePid,bundleId:'org.dsh.fixture'}):await observer.observe({pid:fixturePid,bundleId:'org.dsh.fixture'})
  if(control&&result.ok){
    const nodes=tree=>tree.flatMap(n=>[n,...nodes(n.children??[])])
    if(staleLabel){
      const oldButton=nodes(result.windows).find(n=>n.title==='Save once'&&n.actions?.includes('click'))
      assert.ok(oldButton)
      await writeFile(join(dir,'rename'),'rename')
      const deadline=Date.now()+2000
      while(!stdout.includes('RENAMED')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30))
      assert.ok(stdout.includes('RENAMED'))
      assert.equal((await controlSession.run('click',{target:oldButton.ref})).error_code,'STALE_OR_PROTECTED_TARGET')
      assert.ok(!stdout.includes('"event":"saved"'))
      console.log(JSON.stringify({status:'passed',real_ax_control:true,renamed_control_rejected:true,unintended_saves:0}))
    } else {
    const input=nodes(result.windows).find(n=>n.actions?.includes('fill')&&n.title==='Task title')
    assert.ok(input,'issued plain text input ref')
    assert.ok(nodes(result.windows).some(n=>n.protected===true),'secure field marked protected')
    assert.ok(!JSON.stringify(result).includes('fixture-secret-not-user-data'),'secret excluded')
    const filled=await controlSession.run('fill',{target:input.ref,text:'桌面验收-一次保存'})
    assert.equal(filled.ok,true)
    assert.equal((await controlSession.run('fill',{target:input.ref,text:'stale'})).error_code,'STALE_OR_UNSUPPORTED_REF')
    const fresh=await controlSession.run('observe')
    const button=nodes(fresh.windows).find(n=>n.title==='Save once'&&n.actions?.includes('click'))
    assert.ok(button,'issued save control ref')
    assert.equal((await controlSession.run('click',{target:button.ref})).ok,true)
    assert.equal((await controlSession.run('click',{target:button.ref})).error_code,'STALE_OR_UNSUPPORTED_REF')
    const deadline=Date.now()+2000
    while(!stdout.includes('"event":"saved"')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30))
    const saved=stdout.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}}).filter(e=>e.event==='saved')
    assert.equal(saved.length,1);assert.equal(saved[0].count,1);assert.equal(saved[0].title,'桌面验收-一次保存')
    const checked=await controlSession.run('observe')
    assert.ok(nodes(checked.windows).some(n=>n.role==='AXStaticText'&&n.text==='Saved: 1'),'saved status must be model-visible')
    console.log(JSON.stringify({status:'passed',real_ax_control:true,fill:true,single_save:true,stale_ref_rejected:true,secure_value_absent:true}))
    await controlSession.close()
    process.exitCode=0
    }
  } else {
  if((result.error??result.error_code)==='ACCESSIBILITY_PERMISSION_REQUIRED') {
    console.log(JSON.stringify({status:'permission_required',fixture_started:true,identity_verified:true,real_ax_observation:false}))
    process.exitCode=2
  } else if(!result.ok) {
    const diagnostic=spawnSync(helper,[String(fixturePid),'org.dsh.fixture'],{encoding:'utf8',timeout:8000})
    let identity;try{identity=JSON.parse(diagnostic.stdout)}catch{identity={}}
    console.log(JSON.stringify({status:'failed',fixture_started:true,error:result.error,target_found:identity.target_found,bundle_matches:identity.bundle_matches,start_time_available:identity.start_time_available}))
    process.exitCode=1
  } else {
    const tree=JSON.stringify(result.windows)
    const passed=tree.includes('Save once') && !tree.includes('fixture-secret-not-user-data') && result.values_read===false
    console.log(JSON.stringify({status:passed?'passed':'failed',fixture_started:true,identity_verified:true,real_ax_observation:true,button_found:tree.includes('Save once'),secure_value_absent:!tree.includes('fixture-secret-not-user-data'),nodes:result.nodes,truncated:result.truncated}))
    if(!passed)process.exitCode=1
  }
  }
  }
} finally {
  clearInterval(poll)
  await controlSession?.close()
  if(launchServices&&fixturePid&&child?.exitCode===null){try{process.kill(fixturePid,'SIGTERM')}catch{}}
  if(child && child.exitCode===null) {child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode===null)child.kill('SIGKILL')}
  await rm(dir,{recursive:true,force:true})
}
