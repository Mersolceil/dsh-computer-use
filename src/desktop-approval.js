import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
// Human buttons on a floating panel answer the EXISTING DSH approval seam.
// No model-supplied approval, automatic allow, or persistent permission policy.
export class DesktopApprovalPanel {
 constructor(helperPath){this.helperPath=helperPath}
 close(){this.pending?.cancel()}
 request(reason,{signal}={}){
  this.close();signal?.throwIfAborted()
  return new Promise(resolve=>{
   const id=randomUUID(),child=spawn(this.helperPath,['--approval'],{stdio:['pipe','pipe','ignore']});let raw='',settled=false
   const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(this.pending?.id===id)this.pending=undefined;child.stdin.destroy();child.kill('SIGTERM');resolve(value)}
   const cancel=()=>finish('cancelled'),timer=setTimeout(cancel,120000)
   this.pending={id,cancel};signal?.addEventListener('abort',cancel,{once:true})
   child.on('error',()=>finish('unavailable'));child.on('close',()=>finish('unavailable'));child.stdin.on('error',()=>finish('unavailable'))
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{raw+=chunk;if(raw.length>16384){finish('unavailable');return}const end=raw.indexOf('\n');if(end<0)return;let reply;try{reply=JSON.parse(raw.slice(0,end))}catch{finish('unavailable');return}finish(reply.id===id&&['allowed-once','rejected','cancelled'].includes(reply.outcome)?reply.outcome:'unavailable')})
   child.stdin.write(JSON.stringify({id,reason:String(reason??'').slice(0,5000),duration_seconds:120})+'\n')
  })
 }
}
