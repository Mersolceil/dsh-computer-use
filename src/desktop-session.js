import { spawn } from 'node:child_process'

const bundlePattern=/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
const MAX_OUTPUT=512*1024
export class DesktopSession {
 constructor({helperPath,allowedBundleIds=[],applicationAccess='allowlist',timeoutMs=8000,maxActions=100}){
  if(typeof helperPath!=='string'||!helperPath.startsWith('/')||helperPath.includes('\0'))throw Error('Absolute desktop helper path required')
  if(!Array.isArray(allowedBundleIds)||allowedBundleIds.some(id=>typeof id!=='string'||!bundlePattern.test(id)))throw Error('Invalid application allowlist')
  if(!['standard','allowlist'].includes(applicationAccess))throw Error('Invalid application access mode')
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxActions)||maxActions<1||maxActions>1000)throw Error('Invalid desktop limits')
  Object.assign(this,{helperPath,allowed:new Set(allowedBundleIds),applicationAccess,timeoutMs,maxActions,child:null,refs:new Map(),targets:new Map(),pending:null,nextId:1,actions:0})
 }
 async attach({pid,bundleId,processStart},{signal,verifyTarget}={}){
  signal?.throwIfAborted()
  if(this.child)throw Error('Desktop session already attached')
  if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647||!bundlePattern.test(bundleId??''))throw Error('Invalid desktop target')
  if(this.applicationAccess==='allowlist'&&!this.allowed.has(bundleId))return {ok:false,error_code:'APPLICATION_NOT_ALLOWED'}
  if(processStart!==undefined&&(typeof processStart!=='string'||!/^\d+:\d+$/.test(processStart)))throw Error('Invalid application process identity')
  // A second process-identity check after the native handshake permits reuse of
  // an already authorized V4 AX helper without changing its signing identity.
  const child=spawn(this.helperPath,['--serve',String(pid),bundleId,...(processStart===undefined||verifyTarget?[]:[processStart])],{stdio:['pipe','pipe','ignore'],windowsHide:true})
  this.child=child;this.pid=pid;this.bundleId=bundleId;this.buffer=''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data',chunk=>{
   this.buffer+=chunk
   if(Buffer.byteLength(this.buffer)>MAX_OUTPUT){this.fail('INVALID_HELPER_OUTPUT');return}
   let newline
   while((newline=this.buffer.indexOf('\n'))>=0){
    const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1)
    let value;try{value=JSON.parse(line)}catch{this.fail('INVALID_HELPER_OUTPUT');return}
    const waiting=this.pending
    if(!waiting||!value||typeof value.ok!=='boolean'||(waiting.id!==undefined&&value.id!==waiting.id)){this.fail('INVALID_HELPER_OUTPUT');return}
    this.pending=null;waiting.resolve(value)
   }
  })
  child.on('error',()=>this.fail('DESKTOP_HELPER_FAILED'))
  child.stdin.on('error',()=>this.fail('DESKTOP_HELPER_FAILED'))
  child.on('exit',()=>{if(this.child===child)this.fail('DESKTOP_HELPER_EXITED')})
  const ready=await this.wait(undefined,signal)
  signal?.throwIfAborted()
  if(!ready.ok){await this.close();return ready}
  if(!ready.ready||ready.pid!==pid||ready.bundle_id!==bundleId){this.fail('INVALID_HELPER_OUTPUT');return {ok:false,error_code:'INVALID_HELPER_OUTPUT'}}
  if(verifyTarget){
   try{if(!(await verifyTarget())){await this.close();return {ok:false,error_code:'TARGET_CHANGED'}}}
   catch(error){await this.close();throw error}
  }
  return this.run('observe',{}, {signal})
 }
 wait(id,signal){
  if(this.pending)throw Error('DESKTOP_BUSY')
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.fail('DESKTOP_HELPER_TIMEOUT'),this.timeoutMs)
   const abort=()=>{this.fail('DESKTOP_ABORTED');reject(signal.reason??new DOMException('Aborted','AbortError'))}
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
   this.pending={id,resolve:value=>{cleanup();resolve(value)}}
   signal?.addEventListener('abort',abort,{once:true})
   if(signal?.aborted)abort()
  })
 }
 fail(error){
  const child=this.child;this.child=null;this.refs.clear();this.targets.clear()
  child?.stdin.destroy();child?.kill('SIGKILL')
  const pending=this.pending;this.pending=null
  pending?.resolve({ok:false,error_code:error,state_uncertain:pending.id!==undefined})
 }
 async run(action,args={}, {signal}={}){
  signal?.throwIfAborted()
  if(!['observe','click','fill','confirm'].includes(action))throw Error('Invalid desktop action')
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['target',...(action==='fill'?['text']:[])].includes(k))||(action==='observe'&&Object.keys(args).length))throw Error('Invalid desktop arguments')
  if(!this.child)return {ok:false,error_code:'NO_DESKTOP_SESSION'}
  if(this.pending)return {ok:false,error_code:'DESKTOP_BUSY'}
  if(this.actions>=this.maxActions)return {ok:false,error_code:'DESKTOP_STEP_LIMIT'}
  if(action!=='observe'){
   if(typeof args.target!=='string'||!this.refs.get(args.target)?.includes(action))return {ok:false,error_code:'STALE_OR_UNSUPPORTED_REF'}
   if(action==='fill'&&(typeof args.text!=='string'||Array.from(args.text).length>10000))throw Error('Invalid desktop text')
  }
  const id=this.nextId++,result=this.wait(id,signal)
  this.refs.clear();this.targets.clear();this.actions++
  this.child.stdin.write(JSON.stringify({id,action,...args})+'\n',error=>{if(error)this.fail('DESKTOP_HELPER_FAILED')})
  const value=await result
  signal?.throwIfAborted()
  if(value.ok&&action==='observe'){
   if(value.pid!==this.pid||value.bundle_id!==this.bundleId||value.editable_values_read!==false||value.static_text_values_read!==true||!Array.isArray(value.windows)||!Number.isSafeInteger(value.nodes)||value.nodes<0||value.nodes>800||typeof value.truncated!=='boolean'){this.fail('INVALID_HELPER_OUTPUT');return {ok:false,error_code:'INVALID_HELPER_OUTPUT'}}
   let count=0
   const visit=(node,depth)=>{
    if(!node||typeof node!=='object'||Array.isArray(node)||depth>24||++count>800||typeof node.role!=='string'||Object.keys(node).some(k=>!['role','title','description','text','children','ref','actions','protected'].includes(k)))throw Error('Invalid desktop node')
    for(const key of ['role','title','description','text'])if(node[key]!==undefined&&(typeof node[key]!=='string'||Buffer.byteLength(node[key])>4096))throw Error('Invalid desktop text')
    if(node.text!==undefined&&node.role!=='AXStaticText')throw Error('Editable values are forbidden')
    if(node.protected!==undefined&&node.protected!==true)throw Error('Invalid protection marker')
    if(node.protected&&Object.keys(node).some(k=>!['role','protected'].includes(k)))throw Error('Protected content must be excluded')
    if(node.ref!==undefined){if(node.protected||typeof node.ref!=='string'||node.ref.length>128||this.refs.has(node.ref)||!Array.isArray(node.actions)||!node.actions.length||node.actions.some(a=>!['click','fill','confirm'].includes(a)))throw Error('Invalid desktop ref');this.refs.set(node.ref,node.actions);this.targets.set(node.ref,{role:node.role,title:node.title??node.description??''})}
    else if(node.actions!==undefined)throw Error('Actions require a ref')
    if(node.children!==undefined){if(!Array.isArray(node.children))throw Error('Invalid children');node.children.forEach(n=>visit(n,depth+1))}
   }
   try{value.windows.forEach(n=>visit(n,0));if(count!==value.nodes)throw Error('Invalid node count')}
   catch{this.fail('INVALID_HELPER_OUTPUT');return {ok:false,error_code:'INVALID_HELPER_OUTPUT'}}
  }
  return value
 }
 async close(){this.fail('DESKTOP_SESSION_CLOSED');return {ok:true,closed:true}}
}
