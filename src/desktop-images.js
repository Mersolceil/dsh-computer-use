import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
export const DESKTOP_IMAGES_KEY='computer-use-desktop-images-v1'
const names=new Set(['cu_desktop_screenshot','cu_desktop_display_screenshot','cu_desktop_start','cu_desktop_step','cu_desktop_image_recall'])
// Exact PNG bytes, never the lossy visual guard. Reuse only after a previous
// image is actually committed and remains visible in this agent's own surface.
export class DesktopImageCache {
 clear(){this.last=undefined}
 remember(app,agent,bytes,ref){this.last={app,agent,hash:createHash('sha256').update(bytes).digest('hex'),ref}}
 find(app,agent,bytes){
  const old=this.last
  if(!old||old.agent!==agent||!['pid','process_start','fingerprint'].every(k=>old.app[k]===app[k])||old.hash!==createHash('sha256').update(bytes).digest('hex')||typeof agent.session?.deriveMessages!=='function')return null
  const prior=agent.session.deriveMessages().find(m=>m.role==='tool'&&m.source?.kind==='tool'&&m.content?.some(b=>b.type==='image'&&b.offloaded!==true&&isDeepStrictEqual(b.attachment,old.ref)))
  return prior?{ref:old.ref,message_id:prior.id}:null
 }
}
export function desktopImagesDefinition(){return{
 key:DESKTOP_IMAGES_KEY,stateVersion:1,
 stateSchema:{parse(s){if(!s||!Array.isArray(s.rows)||s.rows.length>64||!s.calls||Object.keys(s.calls).length>64)throw Error('Invalid desktop image checkpoint');return s}},
 init:()=>({rows:[],calls:{},busy:false}),
 apply(s,e){
  if(e.type==='compaction/start')return{...s,busy:true}
  if(['compaction/end','session/end-seed'].includes(e.type))return{...s,busy:false}
  if(e.type==='turn/end')return{...s,calls:{}}
  if(e.type==='tool/call'&&names.has(e.data?.name)&&Object.keys(s.calls).length<64)return{...s,calls:{...s.calls,[e.data.callId]:e.data.name}}
  if(e.type!=='tool/result')return s
  const m=e.data?.message,callId=m?.toolCallId,name=s.calls[callId];if(!name)return s
  const calls={...s.calls};delete calls[callId]
  if(e.surfaceOp!=='append'||m.isError||m.role!=='tool'||m.source?.kind!=='tool'||m.source.callId!==callId||!m.id)return{...s,calls}
  let outcome;try{outcome=JSON.parse(m.content.find(b=>b.type==='text').text)}catch{return{...s,calls}}
  const images=m.content?.filter(b=>b.type==='image')??[]
  if(outcome.ok!==true||!images.length||images.length>2||outcome.state_uncertain||!images.every(b=>b.attachment?.attachmentId))return{...s,calls}
  return{...s,calls,rows:[...s.rows,{seq:e.seq,id:m.id,callId,name,images:images.map(b=>b.attachment)}].slice(-64)}
 }
}}
export async function trimDesktopImages(session,state,attachments,{limit=6,keep=2,signal}={}){
 if(!state||state.busy)return{status:'history_unavailable_or_compaction',offloaded:0}
 const live=new Set(session.surface.nodes),messages=session.deriveMessages(),eligible=[]
 for(const row of state.rows){
  if(!live.has(row.seq))continue
  const group=messages.filter(m=>m.id===row.id);if(group.length!==1)continue
  const m=group[0],images=m.content?.filter(b=>b.type==='image')??[]
  let outcome;try{outcome=JSON.parse(m.content.find(b=>b.type==='text').text)}catch{continue}
  if(m.isError||outcome.ok!==true||outcome.state_uncertain)continue
  if(m.role!=='tool'||m.toolCallId!==row.callId||m.source?.kind!=='tool'||m.source.callId!==row.callId||!isDeepStrictEqual(images.map(b=>b.attachment),row.images))continue
  images.forEach((b,i)=>{if(b.offloaded!==true)eligible.push({seq:row.seq,imageIndex:i,ref:b.attachment})})
 }
 if(eligible.length<=limit)return{status:'below_batch_threshold',offloaded:0,live_images:eligible.length}
 if(typeof attachments?.readImage!=='function')return{status:'attachment_verification_unavailable',offloaded:0}
 const selected=eligible.slice(0,-keep),targets=[]
 for(const item of selected){signal?.throwIfAborted();try{await attachments.readImage(item.ref,signal)}catch{signal?.throwIfAborted();return{status:'attachment_unavailable',offloaded:0}}const last=targets.at(-1);if(last?.seq===item.seq)last.imageIndexes.push(item.imageIndex);else targets.push({seq:item.seq,imageIndexes:[item.imageIndex]})}
 signal?.throwIfAborted()
 try{session.append('image/offload',{targets})}catch(error){if(String(error?.message).includes('requires a message projection'))return{status:'host_projection_unavailable',offloaded:0};throw error}
 return{status:'offloaded',offloaded:selected.length,retained:keep}
}
export function installDesktopImages(ctx,{imageHistoryLimit=6,imageHistoryKeep=2}={}){
 if(!ctx.inject)return
 ctx.inject(['sessionProjections','attachments'],scoped=>{
  scoped.sessionProjections.register(desktopImagesDefinition())
  const statuses=new WeakMap()
  scoped.tools.register({name:'cu_desktop_context_status',description:'Read local desktop image-retention diagnostics. Counts are not provider tokens, cache hits or money. PTC images are not compacted by this policy.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},isConcurrencySafe:()=>true,execute(_a,e){e.signal.throwIfAborted();return{ok:true,...(statuses.get(e.agent.session)??{status:'not_run'}),image_batch_threshold:imageHistoryLimit,images_kept_after_batch:imageHistoryKeep,provider_prompt_cache:'not_measured_by_this_plugin',available_image_event_seqs:(scoped.sessionProjections.stateOf(e.agent.session,DESKTOP_IMAGES_KEY)?.rows??[]).map(r=>r.seq),recent_images:(scoped.sessionProjections.stateOf(e.agent.session,DESKTOP_IMAGES_KEY)?.rows??[]).slice(-8).map(r=>({event_seq:r.seq,action:r.name,source_message_id:r.id}))}}})
  scoped.tools.register({name:'cu_desktop_image_recall',description:'Read a previously delivered desktop image by event_seq in this session. Historical evidence only; never supplies fresh input coordinates. Get a real event_seq from context_status.available_image_event_seqs; never guess IDs.',parameters:{type:'object',properties:{event_seq:{type:'integer',minimum:0}},required:['event_seq'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify({ok:v.ok,error_code:v.error_code,historical:true,event_seq:v.event_seq})},...(v.image_attachment?[{type:'image',attachment:v.image_attachment}]:[])]},isConcurrencySafe:()=>true,async execute(a,e){e.signal.throwIfAborted();if(!Number.isSafeInteger(a.event_seq)||a.event_seq<0)throw Error('Invalid event_seq');const row=scoped.sessionProjections.stateOf(e.agent.session,DESKTOP_IMAGES_KEY)?.rows.find(r=>r.seq===a.event_seq);if(!row)return{ok:false,error_code:'DESKTOP_IMAGE_NOT_FOUND'};await scoped.attachments.readImage(row.images[0],e.signal);e.signal.throwIfAborted();return{ok:true,event_seq:row.seq,image_attachment:row.images[0]}}})
  scoped.on('agent/created',({agent})=>{
   let pending
   scoped.effect(()=>agent.ctx.on('agent/pre-step',async(e,next)=>{const d=await next();pending=Array.isArray(d?.messages)?d.messages.some(m=>m?.source?.kind!=='runtime-context'):undefined;return d}))
   scoped.effect(()=>agent.ctx.on('agent/request',async(e,next)=>{const state=scoped.sessionProjections.stateOf(agent.session,DESKTOP_IMAGES_KEY);const status=pending===false?await trimDesktopImages(agent.session,state,scoped.attachments,{limit:imageHistoryLimit,keep:imageHistoryKeep,signal:e?.signal}):{status:'pending_input_deferred',offloaded:0};statuses.set(agent.session,status);return next()}))
  })
 })
}
