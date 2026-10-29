import { isDeepStrictEqual } from 'node:util'
import { HISTORY_KEY, recallImage } from './history.js'
import { IMAGE_PINS_KEY } from './image-pins.js'

// Select only live, attributable browser screenshots. Never touch user uploads,
// unknown images, ambiguous IDs or pinned evidence. This is a count window,
// not a token budget or a guarantee against other offload plugins.
export function selectImageTargets(session,history,pins,keep=2){
 if(!history||history.busy||!pins||pins.limited||!Array.isArray(pins.pinned)||!Number.isSafeInteger(keep)||keep<1)return []
 const live=new Set(session.surface.nodes),messages=session.deriveMessages(),byId=new Map()
 for(const m of messages){if(typeof m.id!=='string')continue;const group=byId.get(m.id)??[];group.push(m);byId.set(m.id,group)}
 const pinnedIds=new Set()
 for(const row of history.rows){
  if(!pins.pinned.includes(row.seq)||row.name!=='cu_browser_screenshot')continue
  const original=row.mode==='ptc-image'?row.data?.content:row.data?.message?.content
  for(const b of original??[])if(b.type==='image'&&b.attachment?.attachmentId)pinnedIds.add(b.attachment.attachmentId)
 }
 for(const seq of pins.pinned){
  const row=history.rows.find(r=>r.seq===seq&&r.name==='cu_browser_screenshot')
  const blocks=row?.mode==='ptc-image'?row.data?.content:row?.data?.message?.content
  if(!blocks?.some(b=>b.type==='image'&&b.attachment?.attachmentId))return []
 }
 const items=[]
 for(const row of history.rows){
  if(row.name!=='cu_browser_screenshot'||(row.mode&&row.mode!=='ptc-image'))continue
  const seq=row.live_seq??row.seq;if(!live.has(seq))continue
  const original=row.mode==='ptc-image'?row.data:row.data?.message
  if(!original||typeof original.id!=='string'||original.isError)continue
  if(row.mode==='ptc-image'?original.source?.kind!=='ptc-mode':original.source?.kind!=='tool')continue
  const group=byId.get(original.id);if(group?.length!==1)continue
  const current=group[0],priorImages=(original.content??[]).filter(b=>b.type==='image')
  if(current.role!==original.role||current.toolCallId!==original.toolCallId||!isDeepStrictEqual(current.source,original.source))continue
  let outcome;try{outcome=JSON.parse(original.content?.find(b=>b.type==='text')?.text)}catch{continue}
  if(!outcome||outcome.ok!==true||outcome.state_uncertain||outcome.result_uncertain||outcome.uncertain)continue
  const currentImages=(current.content??[]).filter(b=>b.type==='image')
  if(priorImages.length!==currentImages.length||!priorImages.length)continue
  if(!currentImages.every((b,i)=>isDeepStrictEqual(b.attachment,priorImages[i].attachment)))continue
  for(let i=0;i<currentImages.length;i++){
   const block=currentImages[i],ref=block.attachment
   if(block.offloaded===true||!ref?.attachmentId||pinnedIds.has(ref.attachmentId))continue
   items.push({seq,imageIndex:i,ref})
  }
 }
 const targets=new Map()
 for(const item of items.slice(0,Math.max(0,items.length-keep))){
  const entry=targets.get(item.seq)??{seq:item.seq,imageIndexes:[],refs:[]}
  entry.imageIndexes.push(item.imageIndex);entry.refs.push(item.ref);targets.set(item.seq,entry)
 }
 return [...targets.values()]
}

export async function applyImageWindow(session,history,pins,attachments,{keep=2,signal}={}){
 signal?.throwIfAborted()
 if(!history||!pins||!Array.isArray(pins.pinned))return {status:'history_or_pins_unavailable',offloaded:0}
 if(history.busy)return {status:'host_compaction_active',offloaded:0}
 if(pins.limited)return {status:'pin_tracking_limited',offloaded:0}
 if(pins.pinned.some(seq=>!recallImage(history,{event_seq:seq}).ok))return {status:'pinned_evidence_unavailable',offloaded:0}
 if(!Number.isSafeInteger(keep)||keep<1||keep>20)throw Error('Invalid image window size')
 const targets=selectImageTargets(session,history,pins,keep)
 if(!targets.length)return {status:'no_changes',offloaded:0}
 if(typeof attachments?.readImage!=='function')return {status:'attachment_verification_unavailable',offloaded:0}
 try {for(const target of targets)for(const ref of target.refs){await attachments.readImage(ref,signal);signal?.throwIfAborted()}}
 catch {signal?.throwIfAborted();return {status:'attachment_unavailable',offloaded:0}}
 try {
  session.append('image/offload',{targets:targets.map(({seq,imageIndexes})=>({seq,imageIndexes}))})
 } catch(error) {
  // DSH rejects an unknown message projection before appending anything.
  if(String(error?.message).includes('requires a message projection'))return {status:'host_projection_unavailable',offloaded:0}
  throw error
 }
 return {status:'offloaded',offloaded:targets.reduce((n,t)=>n+t.imageIndexes.length,0)}
}
export function installImageWindow(ctx,config){
 if(!config.historyEnabled||!config.imagePinsEnabled||!config.imageWindowEnabled)return
 ctx.inject(['sessionProjections','attachments'],scoped=>{
  const statuses=new WeakMap()
  scoped.tools.register({name:'cu_browser_image_window_status',description:'Read this session’s latest experimental image-window attempt. The status is in-memory and resets on restart. This policy cannot control host or other offload plugins.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>true,
   execute(args,exec){exec.signal.throwIfAborted();if(!exec.agent?.session)throw Error('Image window status requires a DSH session');if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw Error('No arguments expected');return {ok:true,...(statuses.get(exec.agent.session)??{status:'not_run',offloaded:0}),keep:config.imageWindowKeep}}})
  scoped.on('agent/created',({agent})=>{
   // agent/request occurs before the loop admits the current step's newly
   // claimed user input. Give the model one step to see and pin requested
   // evidence before this policy can offload anything.
   let hasPendingInput
   scoped.effect(()=>agent.ctx.on('agent/pre-step',async(event,next)=>{
    const decision=await next()
    hasPendingInput=Array.isArray(decision?.messages)?decision.messages.some(m=>m?.source?.kind!=='runtime-context'):undefined
    return decision
   }))
   scoped.effect(()=>agent.ctx.on('agent/request',async(event,next)=>{
    const history=scoped.sessionProjections.stateOf(agent.session,HISTORY_KEY),pins=scoped.sessionProjections.stateOf(agent.session,IMAGE_PINS_KEY)
    const status=hasPendingInput===undefined?{status:'pending_input_unknown',offloaded:0}:hasPendingInput?{status:'pending_input_deferred',offloaded:0}:history&&pins?await applyImageWindow(agent.session,history,pins,scoped.attachments,{keep:config.imageWindowKeep,signal:event?.signal}):{status:'history_or_pins_unavailable',offloaded:0}
    statuses.set(agent.session,status)
    return next()
   }))
  })
 })
}
