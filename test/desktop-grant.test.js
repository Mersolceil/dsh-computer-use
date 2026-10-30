import test from 'node:test'
import assert from 'node:assert/strict'
import {DesktopGrant} from '../src/desktop-grant.js'
import {DesktopApplications} from '../src/desktop-apps.js'
import {apply} from '../src/desktop-plugin.js'
const app={pid:42,bundle_id:'org.example.fixture',path:'/Applications/Fixture.app',name:'Fixture',fingerprint:'file',process_start:'1:2'}
const metadata={ok:true,capture_source:'macos-window',screenshot_id:'shot-1',visual_stamp:'a'.repeat(64),window_id:17,front_window_id:17,capture_rect:{x:0,y:0,width:1,height:1}}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==','base64')
test('task grant binds owner, exact process/window, limits and cancellation',()=>{
 let now=1000,revocations=0;const grant=new DesktopGrant({now:()=>now,onRevoke:()=>revocations++}),agent={}
 grant.issue(app,17,agent,{actions:2,duration:10,control:false})
 assert.equal(grant.matches(app,17,{},false),false);assert.equal(grant.matches({...app,process_start:'3:4'},17,agent),false);assert.equal(grant.matches(app,18,agent),false);assert.equal(grant.matches(app,17,agent,true),false)
 const signal=grant.take(app,17,agent);assert.equal(signal.aborted,false);grant.take(app,17,agent);assert.equal(grant.take(app,17,agent),null);assert.equal(signal.aborted,true)
 grant.issue(app,17,agent,{duration:10});now=11001;assert.equal(grant.status(agent).active,false);assert.equal(revocations,2)
 grant.issue(app,17,agent);const s=grant.take(app,17,agent);grant.revoke();assert.equal(s.aborted,true)
 assert.throws(()=>grant.issue(app,17,agent,{duration:901}),/bounds/)
})
test('one task approval covers repeated selected-window capture/control; focus preserves tickets; sensitive and display scopes still ask',async()=>{
 const methods=['inspect','windows','screenshot','visual','status','focus','displayScreenshot'],originals=methods.map(k=>DesktopApplications.prototype[k]),defs=new Map(),listeners=new Map();let asked=0,outcome='allowed-once',inputs=0,policy='ask'
 DesktopApplications.prototype.inspect=async()=>({ok:true,application:app})
 // Partial/off-display metadata is deliberately not treated as hidden.
 DesktopApplications.prototype.windows=async()=>({ok:true,windows:[{window_id:17,on_screen:false,display_geometry:'partly_outside_or_spanning_displays'}]})
 DesktopApplications.prototype.screenshot=async()=>({...metadata,screenshot:{mimeType:'image/png',data:png.toString('base64'),width:1,height:1}})
 DesktopApplications.prototype.visual=async()=>{inputs++;return {ok:true}}
 DesktopApplications.prototype.focus=async()=>({ok:true,status:'focused'})
 DesktopApplications.prototype.status=async()=>({ok:true,protocol:'dsh-desktop/2',features:['atomic_focus_input','independent_window_capture','local_window_preview'],displays:[{display_id:1}]})
 DesktopApplications.prototype.displayScreenshot=async()=>{throw Error('Denied display scope must not capture')}
 const ctx={tools:{register:def=>{defs.set(def.name,def);return()=>{}}},on:(n,fn)=>{listeners.set(n,[...(listeners.get(n)??[]),fn])},get:()=>({request:async()=>{asked++;return outcome},effectivePolicy:()=>policy}),attachments:{saveImages:async()=>[{attachmentId:'sha256:fixture',mediaType:'image/png',width:1,height:1,bytes:png.length}]}}
 const agent={session:{}},call=(n,args={})=>defs.get('cu_desktop_'+n).execute(args,{agent,signal:new AbortController().signal,callId:'unit'})
 try{
  apply(ctx,{helperPath:'/helper',maxActions:50,nativeApprovalEnabled:false});await call('mode',{mode:'visual'})
  const args={pid:42,bundleId:app.bundle_id,window_id:17,purpose:'编辑临时文档',control:true,preview:false,max_actions:10}
  assert.equal((await call('authorize',args)).ok,true);assert.equal(asked,1)
  await call('screenshot',{pid:42,bundleId:app.bundle_id,window_id:17});await call('focus',{pid:42,bundleId:app.bundle_id});assert.equal((await call('type',{screenshot_id:'shot-1',text:'中文'})).ok,true)
  await call('screenshot',{pid:42,bundleId:app.bundle_id,window_id:17});await call('key',{screenshot_id:'shot-1',key:'Meta+S'});assert.equal(asked,1);assert.equal(inputs,2)
  outcome='rejected';assert.equal((await call('display_screenshot',{pid:42,bundleId:app.bundle_id,display_id:1})).error_code,'APPROVAL_REJECTED');assert.equal(asked,2)
  await call('screenshot',{pid:42,bundleId:app.bundle_id,window_id:17});assert.equal(asked,2)
  assert.equal((await call('key',{screenshot_id:'shot-1',key:'Enter'})).error_code,'APPROVAL_REJECTED');assert.equal(inputs,2);assert.equal((await call('status')).task_authorization.active,false)
  outcome='allowed-once';await call('authorize',args);policy='never';outcome='rejected';assert.equal((await call('screenshot',{pid:42,bundleId:app.bundle_id,window_id:17})).error_code,'APPROVAL_REJECTED')
  policy='ask';outcome='allowed-once';await call('authorize',args);for(const fn of listeners.get('session/event'))await fn(agent.session,{type:'turn/end',data:{}});assert.equal((await call('status')).task_authorization.active,false)
 }finally{for(const fn of listeners.get('dispose')??[])await fn();methods.forEach((m,i)=>DesktopApplications.prototype[m]=originals[i])}
})
