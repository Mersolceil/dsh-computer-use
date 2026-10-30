import test from 'node:test'
import assert from 'node:assert/strict'
import {VisualContext} from '../src/desktop-visual.js'
import {DesktopApplications} from '../src/desktop-apps.js'
import {DesktopSession} from '../src/desktop-session.js'
import {apply} from '../src/desktop-plugin.js'
const app={pid:42,bundle_id:'org.example.fixture',path:'/Applications/Fixture.app',name:'Fixture',fingerprint:'file',process_start:'1:2'}
const metadata={ok:true,capture_source:'macos-window',screenshot_id:'shot-1',visual_stamp:'a'.repeat(64),visual_focus_sample:'local-only',window_id:17,front_window_id:17,capture_rect:{x:0,y:0,width:1,height:1}}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==','base64')
test('visual image tickets bind owner, geometry, age and one attempted action',()=>{
 let now=1;const visual=new VisualContext({now:()=>now,maxAge:100}),agent={};visual.issue(app,metadata,{width:1,height:1},agent)
 assert.equal(visual.peek('shot-1',{}),null);assert.equal(visual.peek('invented',agent),null);assert.equal(visual.consume('shot-1',agent).app.pid,42);assert.equal(visual.peek('shot-1',agent),null)
 visual.issue(app,metadata,{width:1,height:1},agent);now=102;assert.equal(visual.peek('shot-1',agent),null)
 assert.throws(()=>visual.issue(app,{...metadata,visual_stamp:undefined},{width:1,height:1},agent),/update the helper/)
})
test('screenshot-only mode blocks AX and gates visual effects without touching the clipboard',async()=>{
 const methods=['inspect','windows','screenshot','visual','status','focus'],originals=methods.map(k=>DesktopApplications.prototype[k]),oldAttach=DesktopSession.prototype.attach,defs=new Map(),disposers=[];let outcome='rejected',inputs=0,AX=0
 DesktopSession.prototype.attach=async()=>{AX++;throw Error('AX must never run')}
 DesktopApplications.prototype.inspect=async()=>({ok:true,application:app})
 DesktopApplications.prototype.windows=async()=>({ok:true,windows:[{window_id:17,on_screen:true}]})
 DesktopApplications.prototype.screenshot=async()=>({...metadata,screenshot:{mimeType:'image/png',data:png.toString('base64'),width:1,height:1}})
 DesktopApplications.prototype.visual=async(_app,context,action,input)=>{inputs++;assert.equal(context.visual_stamp,metadata.visual_stamp);assert.equal(action,'type');assert.equal(input.text,'中文\n第二行');return{ok:true,requires_fresh_screenshot:true,ax_tree_reads_performed:false,clipboard_used:false}}
 DesktopApplications.prototype.status=async()=>({ok:true,protocol:'dsh-desktop/2',helper_version:'0.10.0-alpha.1',accessibility_input:true,screen_recording:true,displays:[]})
 DesktopApplications.prototype.focus=async()=>({ok:true,status:'focused',ax_tree_reads_performed:false})
 const ctx={tools:{register:def=>{defs.set(def.name,def);return()=>defs.delete(def.name)}},on:(name,fn)=>{if(name==='dispose')disposers.push(fn)},get:()=>({request:async()=>outcome}),attachments:{saveImages:async()=>[{attachmentId:'sha256:fixture',mediaType:'image/png',width:1,height:1,bytes:png.length}]}}
 const agent={session:{}},call=(name,args={})=>defs.get('cu_desktop_'+name).execute(args,{agent,signal:new AbortController().signal,callId:'visual-unit'})
 try{
  apply(ctx,{helperPath:'/helper',maxActions:40})
  const status=await call('status');assert.equal(status.helper.protocol,'dsh-desktop/2');assert.equal(status.observation_mode,'semantic')
  await call('mode',{mode:'visual'})
  for(const [name,args] of [['observe',{}],['attach',{pid:42,bundleId:app.bundle_id}],['click',{target:'ref'}],['fill',{target:'ref',text:'forbidden'}],['confirm',{target:'ref'}]])assert.equal((await call(name,args)).error_code,'VISUAL_MODE_BLOCKS_AX')
  assert.equal(AX,0)
  outcome='allowed-once';const picture=await call('screenshot',{pid:42,bundleId:app.bundle_id,window_id:17});assert.equal(picture.visual_stamp,undefined);assert.equal(picture.visual_sample,undefined);assert.equal(picture.visual_focus_sample,undefined);assert.equal(picture.visual_context.width,1)
  outcome='rejected';assert.equal((await call('type',{screenshot_id:'shot-1',text:'中文\n第二行'})).error_code,'APPROVAL_REJECTED');assert.equal(inputs,0)
  assert.equal((await call('mode',{mode:'semantic'})).error_code,'APPROVAL_REJECTED');assert.equal((await call('status')).observation_mode,'visual')
  outcome='allowed-once';const typed=await call('type',{screenshot_id:'shot-1',text:'中文\n第二行'});assert.equal(typed.clipboard_used,false);assert.equal(inputs,1)
  assert.equal((await call('type',{screenshot_id:'shot-1',text:'again'})).error_code,'STALE_SCREENSHOT')
  await assert.rejects(call('key',{screenshot_id:'anything',key:'Meta+V'}),/argument value/)
  assert.equal(AX,0)
 }finally{for(const fn of disposers)await fn();methods.forEach((k,i)=>DesktopApplications.prototype[k]=originals[i]);DesktopSession.prototype.attach=oldAttach}
})
test('a profile can lock screenshot-only mode; old helper status cannot masquerade as a usable visual backend',async()=>{
 const old=DesktopApplications.prototype.status;DesktopApplications.prototype.status=async()=>({ok:false,error_code:'INVALID_ACTION'})
 const defs=new Map(),disposers=[],ctx={tools:{register:s=>{defs.set(s.name,s);return()=>{}}},on:(n,fn)=>{if(n==='dispose')disposers.push(fn)}}
 try{apply(ctx,{helperPath:'/old-helper',observationMode:'visual'});const exec={agent:{session:{}},signal:new AbortController().signal};assert.equal((await defs.get('cu_desktop_mode').execute({mode:'semantic'},exec)).error_code,'PROFILE_LOCKS_VISUAL_MODE');const status=await defs.get('cu_desktop_status').execute({},exec);assert.equal(status.error_code,'HELPER_UPGRADE_REQUIRED');assert.equal(status.observation_mode,'visual')}
 finally{for(const fn of disposers)await fn();DesktopApplications.prototype.status=old}
})
