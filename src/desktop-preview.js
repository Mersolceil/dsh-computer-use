import {spawn} from 'node:child_process'
// Images remain in the native preview process: no image history, model tokens,
// network endpoint, clipboard or file output. Closing it revokes the task.
export class DesktopPreview {
 constructor(helperPath,onStop=()=>{}){this.helperPath=helperPath;this.onStop=onStop}
 stop(){const child=this.child;this.child=undefined;if(child){child.stdin.destroy();child.kill('SIGTERM')}}
 async start(app,windowId,{duration=300,signal}={}){
  this.stop();this.frames=0;signal?.throwIfAborted()
  return new Promise(resolve=>{
   const child=spawn(this.helperPath,['--preview'],{stdio:['pipe','pipe','ignore']});this.child=child
   let raw='',settled=false,readyMetadata
   const done=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)}
   const stopped=()=>{signal?.removeEventListener('abort',abort);if(this.child===child){this.child=undefined;this.onStop()}done({ok:false,error_code:'PREVIEW_STOPPED'})}
   const abort=()=>{if(this.child===child)this.stop();done({ok:false,error_code:'PREVIEW_CANCELLED'})}
   const timer=setTimeout(()=>{abort()},10000)
   signal?.addEventListener('abort',abort,{once:true})
   child.on('error',stopped);child.on('close',stopped);child.stdin.on('error',stopped)
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{raw+=chunk;if(raw.length>65536){abort();return}let end;while((end=raw.indexOf('\n'))>=0){const line=raw.slice(0,end);raw=raw.slice(end+1);let event;try{event=JSON.parse(line)}catch{abort();return}if(event.ready){readyMetadata=event}else if(event.event==='frame'){this.frames=event.frames;if(readyMetadata)done({...readyMetadata,first_frame_received:true,preview_pid:child.pid})}else if(event.event==='stopped'||event.ok===false){if(this.child===child){this.stop();this.onStop()}done(event)}}})
   child.stdin.write(JSON.stringify({pid:app.pid,bundle_id:app.bundle_id,process_start:app.process_start,path:app.path,fingerprint:app.fingerprint,window_id:windowId,duration_seconds:duration})+'\n')
  })
 }
}
