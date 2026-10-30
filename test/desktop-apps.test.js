import test from 'node:test'
import assert from 'node:assert/strict'
import {applicationDecision,requireDesktopApproval,DesktopApplications} from '../src/desktop-apps.js'
import {DesktopSession} from '../src/desktop-session.js'
import {apply} from '../src/desktop-plugin.js'
const app={bundle_id:'org.example.editor',name:'Editor',path:'/Applications/Editor.app',fingerprint:'known-file',trusted_location:true,pid:42,process_start:'123:4'}
test('ordinary apps work by default; strict mode and protected applications remain enforced',()=>{
 assert.equal(applicationDecision(app).allow,true)
 assert.equal(applicationDecision(app,{},'attach').allow,true)
 assert.equal(applicationDecision(app,{applicationAccess:'allowlist'}).deny,'APPLICATION_NOT_ALLOWED')
 assert.equal(applicationDecision(app,{applicationAccess:'allowlist',allowedBundleIds:[app.bundle_id]}).allow,true)
 assert.equal(applicationDecision({...app,bundle_id:'com.deepseek.dsh'}, {},'quit').deny,'PROTECTED_APPLICATION')
 assert.equal(applicationDecision(app,{applicationAccess:'invalid'}).deny,'INVALID_APPLICATION_POLICY')
})
test('sensitive apps, unusual launch locations and every whole-app quit require approval',()=>{
 assert.ok(applicationDecision({...app,bundle_id:'com.apple.Terminal'}).ask)
 assert.ok(applicationDecision({...app,bundle_id:'com.apple.keychainaccess'},{},'attach').ask)
 assert.ok(applicationDecision({...app,trusted_location:false}).ask)
 assert.ok(applicationDecision(app,{},'quit').ask)
 assert.equal(applicationDecision({...app,process_start:undefined},{},'quit').deny,'INVALID_APPLICATION_IDENTITY')
})
test('approval fails closed and only the one-shot outcome grants this call',async()=>{
 const exec={name:'cu_desktop_quit',callId:'call-1',agent:{},signal:new AbortController().signal}
 assert.equal((await requireDesktopApproval({},exec,'quit')).error_code,'APPROVAL_UNAVAILABLE')
 for(const outcome of ['rejected','cancelled','unavailable','approved',undefined]){
  assert.equal((await requireDesktopApproval({get:()=>({request:async request=>{assert.equal(request.agent,exec.agent);assert.equal(request.callId,exec.callId);return outcome}})},exec,'quit')).performed,false)
 }
 assert.equal(await requireDesktopApproval({get:()=>({request:async()=> 'allowed-once'})},exec,'quit'),null)
 const aborted=AbortSignal.abort();await assert.rejects(requireDesktopApproval({}, {...exec,signal:aborted},'quit'),{name:'AbortError'})
})
test('lifecycle transport carries immutable identity, defaults to background and exposes no shell',async()=>{
 const requests=[],manager=new DesktopApplications({helperPath:'/helper'},async r=>{requests.push(r);return {ok:true}})
 await manager.open(app);await manager.quit(app)
 assert.deepEqual(requests,[{action:'open',path:app.path,bundle_id:app.bundle_id,fingerprint:app.fingerprint,activate:false},{action:'quit',pid:42,bundle_id:app.bundle_id,process_start:'123:4',path:app.path,fingerprint:app.fingerprint}])
 assert.throws(()=>manager.resolve('https://example.com\n/Applications/X.app'))
 assert.throws(()=>manager.inspect(0,app.bundle_id))
})
test('plugin denies effects before approval, rejects bypass flags, reasks and leaves prompts intact',async()=>{
 const originals=[DesktopApplications.prototype.resolve,DesktopApplications.prototype.inspect,DesktopApplications.prototype.open,DesktopApplications.prototype.quit,DesktopSession.prototype.attach,DesktopSession.prototype.run,DesktopSession.prototype.close]
 const effects=[],requests=[],tools=new Map(),handlers=new Map();let outcome='rejected'
 const ctx={tools:{register:s=>{tools.set(s.name,s);return()=>tools.delete(s.name)}},on:(n,f)=>{handlers.set(n,[...(handlers.get(n)??[]),f])},get:()=>({request:async r=>{requests.push(r);return outcome}})}
 DesktopApplications.prototype.resolve=async()=>({ok:true,application:app})
 DesktopApplications.prototype.inspect=async()=>({ok:true,application:app})
 DesktopApplications.prototype.open=async(a,o)=>{effects.push(['open',a,o.activate]);return {ok:true,application:a}}
 DesktopApplications.prototype.quit=async a=>{effects.push(['quit',a]);return {ok:true,closed:false,requires_user_attention:true}}
 DesktopSession.prototype.attach=async function(target,options){assert.equal(await options.verifyTarget(),true);this.bundleId=target.bundleId;this.pid=target.pid;this.refs.set('fresh',['click']);this.targets.set('fresh',{title:'Save',role:'AXButton'});return {ok:true}}
 DesktopSession.prototype.run=async action=>{effects.push([action]);return {ok:true}}
 DesktopSession.prototype.close=async()=>({ok:true})
 try{
  apply(ctx,{helperPath:'/helper',maxActions:30})
  const agent={session:{}},exec={agent,signal:new AbortController().signal,callId:'current'},call=(n,a={})=>tools.get('cu_desktop_'+n).execute(a,exec)
  assert.equal((await call('open',{application:'Editor'})).ok,true);assert.equal(requests.length,0)
  assert.equal((await call('quit',{pid:42,bundleId:app.bundle_id})).error_code,'APPROVAL_REJECTED');assert.equal(effects.length,1)
  await assert.rejects(call('quit',{pid:42,bundleId:app.bundle_id,approved:true}),/Invalid desktop arguments/)
  outcome='allowed-once';assert.equal((await call('quit',{pid:42,bundleId:app.bundle_id})).requires_user_attention,true)
  assert.equal((await call('attach',{pid:42,bundleId:app.bundle_id})).ok,true)
  assert.equal((await call('click',{target:'stale'})).error_code,'STALE_OR_UNSUPPORTED_REF')
  outcome='rejected';assert.equal((await call('click',{target:'fresh'})).error_code,'APPROVAL_REJECTED');assert.equal(effects.length,2)
  outcome='allowed-once';await call('click',{target:'fresh'});assert.equal(effects.at(-1)[0],'click')
  const before=requests.length;await call('quit',{pid:42,bundleId:app.bundle_id});assert.equal(requests.length,before+1)
  assert.equal((await call('close')).application_closed,false)
 }finally{
  for(const fn of handlers.get('dispose')??[])await fn()
  ;[DesktopApplications.prototype.resolve,DesktopApplications.prototype.inspect,DesktopApplications.prototype.open,DesktopApplications.prototype.quit,DesktopSession.prototype.attach,DesktopSession.prototype.run,DesktopSession.prototype.close]=originals
 }
})
