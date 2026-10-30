// An explicit, bounded task approval. Never inferred from a tool argument,
// previous per-action approval, app text, another agent or a restarted process.
export class DesktopGrant {
 constructor({now=Date.now,onRevoke=()=>{}}={}){this.now=now;this.onRevoke=onRevoke}
 revoke(){const grant=this.current;this.current=undefined;if(grant){clearTimeout(grant.timer);grant.controller.abort();this.onRevoke()}}
 issue(app,windowId,agent,{duration=300,actions=100,control=true,preview=true,purpose=''}={}){
  if(!Number.isInteger(duration)||duration<10||duration>900||!Number.isInteger(actions)||actions<1||actions>200||!Number.isSafeInteger(windowId)||windowId<1)throw Error('Invalid task grant bounds')
  this.revoke();const controller=new AbortController(),grant={app:{...app},windowId,agent,control,preview,purpose,remaining:actions,expires:this.now()+duration*1000,controller}
  grant.timer=setTimeout(()=>this.revoke(),duration*1000);grant.timer.unref?.();this.current=grant;return this.status(agent)
 }
 matches(app,windowId,agent,control=false){const g=this.current;if(!g)return false;if(this.now()>=g.expires||g.remaining<=0){this.revoke();return false}return g.agent===agent&&g.windowId===windowId&&(!control||g.control)&&['pid','bundle_id','path','process_start','fingerprint'].every(k=>g.app[k]===app[k])}
 take(app,windowId,agent,control=false){if(!this.matches(app,windowId,agent,control))return null;const g=this.current;g.remaining--;return g.controller.signal}
 status(agent){const g=this.current;if(!g)return{active:false};if(this.now()>=g.expires||g.remaining<=0){this.revoke();return{active:false}}if(g.agent!==agent)return{active:true,owned_by_other_agent:true};return{active:true,pid:g.app.pid,bundle_id:g.app.bundle_id,window_id:g.windowId,control:g.control,local_preview:g.preview,remaining:g.remaining,expires_at:new Date(g.expires).toISOString(),includes_full_display:false}}
}
