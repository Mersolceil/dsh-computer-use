import {spawn} from 'node:child_process'
const bundlePattern=/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const protectedIds=new Set(['com.apple.loginwindow','com.apple.windowserver','com.apple.dock','com.apple.finder','com.deepseek.dsh','com.openai.codex','org.dsh.desktophelper.control.experimental'])
const sensitiveIds=/keychain|password|onepassword|1password|bitwarden|lastpass|authenticator|wallet|systempreferences|terminal|iterm|securityagent/i
export function applicationDecision(app,{applicationAccess='standard',allowedBundleIds=[]}={},operation='open'){
 if(!['standard','allowlist'].includes(applicationAccess)||!['open','attach','quit'].includes(operation))return {deny:'INVALID_APPLICATION_POLICY'}
 if(!app||typeof app.bundle_id!=='string'||!bundlePattern.test(app.bundle_id)||typeof app.path!=='string'||!app.path.startsWith('/')||!app.path.endsWith('.app')||typeof app.fingerprint!=='string'||!app.fingerprint)return {deny:'INVALID_APPLICATION_IDENTITY'}
 if(operation!=='open'&&(!Number.isSafeInteger(app.pid)||typeof app.process_start!=='string'||!/^\d+:\d+$/.test(app.process_start)))return {deny:'INVALID_APPLICATION_IDENTITY'}
 if(applicationAccess==='allowlist'&&!allowedBundleIds.includes(app.bundle_id))return {deny:'APPLICATION_NOT_ALLOWED'}
 if(operation==='quit'&&protectedIds.has(app.bundle_id.toLowerCase()))return {deny:'PROTECTED_APPLICATION'}
 if(operation==='quit')return {ask:'退出整个应用会关闭它的窗口，并可能影响未保存内容或正在执行的任务。只会请求正常退出，不会强制结束。'}
 if(sensitiveIds.test(app.bundle_id+' '+app.name))return {ask:operation==='attach'?'连接此敏感应用将读取其界面，直到断开；修改操作仍需单独授权。':'即将打开敏感应用，需要确认。'}
 if(operation==='open'&&app.trusted_location!==true)return {ask:'此应用位于常规安装目录以外，启动前需要确认；系统安全提示仍由你处理。'}
 return {allow:true}
}
export async function requireDesktopApproval(ctx,exec,reason){
 exec.signal.throwIfAborted()
 const service=ctx.get?.('approval')
 if(!exec.agent||typeof service?.request!=='function')return {ok:false,error_code:'APPROVAL_UNAVAILABLE',performed:false,message:'没有可用的DSH授权通道，操作未执行。'}
 const outcome=await service.request({agent:exec.agent,toolName:exec.name,callId:exec.callId,reason,signal:exec.signal})
 exec.signal.throwIfAborted()
 if(outcome==='allowed-once')return null
 return {ok:false,error_code:outcome==='rejected'?'APPROVAL_REJECTED':outcome==='cancelled'?'APPROVAL_CANCELLED':'APPROVAL_UNAVAILABLE',performed:false,message:'操作未获得本次授权，未执行；不能用参数或旧授权绕过。'}
}
export class DesktopApplications{
 constructor({helperPath,timeoutMs=15000},transport){
  if(typeof helperPath!=='string'||!helperPath.startsWith('/')||helperPath.includes('\0'))throw Error('Absolute helper path required')
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('Invalid application timeout')
  this.helperPath=helperPath;this.timeoutMs=timeoutMs;this.transport=transport
 }
 async call(request,{signal}={}){
  signal?.throwIfAborted()
  if(this.transport)return this.transport(request,{signal})
  return new Promise((resolve,reject)=>{
   const child=spawn(this.helperPath,['--applications'],{stdio:['pipe','pipe','ignore'],windowsHide:true})
   let raw='',settled=false
   const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(value)}
   const fail=code=>{child.kill('SIGKILL');finish({ok:false,error_code:code,state_uncertain:['open','quit','focus','visual_input'].includes(request.action)})}
   const abort=()=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(signal.reason??new DOMException('Aborted','AbortError'))}
   const timer=setTimeout(()=>fail('APPLICATION_HELPER_TIMEOUT'),this.timeoutMs)
   signal?.addEventListener('abort',abort,{once:true})
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{raw+=chunk;if(Buffer.byteLength(raw)>(['screenshot','display_screenshot'].includes(request.action)?6*1024*1024:65536))fail('INVALID_APPLICATION_OUTPUT')})
   child.on('error',()=>fail('APPLICATION_HELPER_FAILED'));child.stdin.on('error',()=>fail('APPLICATION_HELPER_FAILED'))
   child.on('close',(code,exitSignal)=>{if(settled)return;const invalid=()=>finish({ok:false,error_code:'INVALID_APPLICATION_OUTPUT',exit_code:code,exit_signal:exitSignal,output_bytes:Buffer.byteLength(raw),state_uncertain:['open','quit','focus','visual_input'].includes(request.action)});let value;try{value=JSON.parse(raw)}catch{invalid();return}if(typeof value?.ok!=='boolean'||(code!==0&&value.ok)){invalid();return}finish(value)})
   child.stdin.end(JSON.stringify(request)+'\n')
  })
 }
 resolve(application,options){if(typeof application!=='string'||!application.trim()||application.length>1024||/[\0\n\r]/.test(application))throw Error('Use an installed application name, bundle ID or absolute .app path');return this.call({action:'resolve',application},options)}
 inspect(pid,bundleId,options){if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647||!bundlePattern.test(bundleId??''))throw Error('Invalid application target');return this.call({action:'inspect',pid,bundle_id:bundleId},options)}
 open(app,{activate=false,...options}={}){if(typeof activate!=='boolean')throw Error('activate must be boolean');return this.call({action:'open',path:app.path,bundle_id:app.bundle_id,fingerprint:app.fingerprint,activate},options)}
 quit(app,options){return this.call({action:'quit',pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint},options)}
 windows(app,options){return this.call({action:'windows',pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint},options)}
 screenshot(app,windowId,{maxDimension=1024,...options}={}){if(!Number.isSafeInteger(windowId)||windowId<1||windowId>4294967295)throw Error('Use an issued window_id');return this.call({action:'screenshot',pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint,window_id:windowId,max_dimension:maxDimension},options)}
 status(options){return this.call({action:'status'},options)}
 displayScreenshot(app,displayId,options){if(!Number.isSafeInteger(displayId)||displayId<1||displayId>4294967295)throw Error('Use an issued display_id');return this.call({action:'display_screenshot',pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint,display_id:displayId},options)}
 focus(app,options){return this.call({action:'focus',pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint},options)}
 visual(app,visual,action,input,options){if(!['key','type','pixel_click','scroll'].includes(action))throw Error('Invalid visual action');return this.call({action:'visual_input',pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint,visual,input_action:action,input,restore_focus:true,restore_host:true},options)}
}
