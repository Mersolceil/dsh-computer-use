import test from 'node:test'
import assert from 'node:assert/strict'
import {apply} from '../src/desktop-plugin.js'
import {DesktopApplications} from '../src/desktop-apps.js'
import {DesktopPreview} from '../src/desktop-preview.js'
import {DesktopApprovalPanel} from '../src/desktop-approval.js'
const app={pid:42,bundle_id:'org.example.fixture',path:'/Applications/Fixture.app',name:'Fixture',fingerprint:'file',process_start:'1:2',trusted_location:true}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==','base64')
const metadata={ok:true,capture_source:'macos-window',screenshot_id:'shot',visual_stamp:'a'.repeat(64),window_id:17,front_window_id:17,capture_rect:{x:0,y:0,width:1,height:1},screenshot:{mimeType:'image/png',data:png.toString('base64'),width:1,height:1}}
test('start/step use one task grant; repeated mode/start do not reset it; changed-window ambiguity never grants',async()=>{
 const methods=['resolve','open','inspect','windows','screenshot','visual','status'],saved=methods.map(k=>DesktopApplications.prototype[k]),oldStart=DesktopPreview.prototype.start,oldStop=DesktopPreview.prototype.stop,defs=new Map(),listeners=new Map();let approvals=0,inputs=0,captures=0,ambiguous=false,postFailure=false
 DesktopApplications.prototype.resolve=async()=>({ok:true,application:app});DesktopApplications.prototype.open=async(_a,o)=>{assert.equal(o.activate,false);return{ok:true,application:app}}
 DesktopApplications.prototype.inspect=async()=>({ok:true,application:app})
 DesktopApplications.prototype.windows=async()=>({ok:true,windows:[{window_id:17,on_screen:true,layer:0},...(ambiguous?[{window_id:18,on_screen:true,layer:0}]:[])]})
 DesktopApplications.prototype.screenshot=async()=>{captures++;return postFailure?{ok:false,error_code:'CAPTURE_FAILED'}:metadata}
 DesktopApplications.prototype.visual=async()=>{inputs++;return{ok:true,state_uncertain:true,verification_scope:'event_delivery_only'}}
 DesktopApplications.prototype.status=async()=>({ok:true,protocol:'dsh-desktop/2',features:['atomic_focus_input','independent_window_capture','local_window_preview']})
 DesktopPreview.prototype.start=async function(){this.child={};return{ok:true}}
 DesktopPreview.prototype.stop=function(){this.child=undefined}
 const ctx={tools:{register:d=>{defs.set(d.name,d);return()=>{}}},on:(n,fn)=>listeners.set(n,[...(listeners.get(n)??[]),fn]),get:()=>({request:async()=>{approvals++;return 'allowed-once'}}),attachments:{saveImages:async()=>[{attachmentId:'sha256:test',mediaType:'image/png',width:1,height:1,bytes:png.length}]}}
 const agent={session:{}},call=(n,a)=>defs.get('cu_desktop_'+n).execute(a,{agent,signal:new AbortController().signal,callId:n})
 try{
  apply(ctx,{helperPath:'/helper',nativeApprovalEnabled:false,maxActions:60})
  const start={application:'Fixture',purpose:'输入临时文本',control:true}
  assert.equal((await call('start',start)).ok,true);assert.equal(approvals,1);assert.equal(captures,1)
  await call('mode',{mode:'visual'});assert.equal((await call('start',start)).ok,true);assert.equal(approvals,1,'no hidden renewal or repeated task approval')
  let r=await call('step',{action:'type',screenshot_id:'shot',text:'中文'});assert.equal(r.ok,true);assert.equal(inputs,1);assert.equal(r.action_result.state_uncertain,true);assert.equal(approvals,1)
  postFailure=true;r=await call('step',{action:'key',screenshot_id:'shot',key:'Meta+S'});assert.equal(r.failed_stage,'after_input_capture');assert.equal(r.never_replay_whole_step,true);assert.equal(inputs,2)
  ambiguous=true;r=await call('start',start);assert.equal(r.error_code,'SELECT_WINDOW_REQUIRED');assert.equal(approvals,1)
 }finally{for(const fn of listeners.get('dispose')??[])await fn();methods.forEach((m,i)=>DesktopApplications.prototype[m]=saved[i]);DesktopPreview.prototype.start=oldStart;DesktopPreview.prototype.stop=oldStop}
})
test('native answerer handles only its exact in-flight request; real host policy remains authoritative',async()=>{
 const defs=new Map(),listeners=new Map(),old=DesktopApprovalPanel.prototype.request;let panels=0,policy='ask'
 DesktopApprovalPanel.prototype.request=async()=>{panels++;return'allowed-once'}
 const ctx={tools:{register:d=>{defs.set(d.name,d);return()=>{}}},on:(n,fn)=>listeners.set(n,[...(listeners.get(n)??[]),fn]),get:()=>({effectivePolicy:()=>policy,request:async req=>policy==='never'?'rejected':listeners.get('approval/request')[0](req,()=>Promise.resolve('unavailable'))})}
 const agent={session:{}},call=mode=>defs.get('cu_desktop_mode').execute({mode},{agent,signal:new AbortController().signal,callId:'mode'})
 try{apply(ctx,{helperPath:'/helper',observationMode:'semantic'});await call('visual');assert.equal((await call('semantic')).ok,true);assert.equal(panels,1);await call('visual');policy='never';assert.equal((await call('semantic')).error_code,'APPROVAL_REJECTED');assert.equal(panels,1);let delegated=false;await listeners.get('approval/request')[0]({agent,toolName:'another_tool',callId:'other'},()=>{delegated=true});assert.equal(delegated,true)}finally{for(const fn of listeners.get('dispose')??[])await fn();DesktopApprovalPanel.prototype.request=old}
})
