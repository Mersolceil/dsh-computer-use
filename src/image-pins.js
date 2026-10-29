import { HISTORY_KEY, recallImage } from './history.js'

// Experimental persisted pin decisions. Pins express retention intent, not
// verified business facts and not permission to restore stale coordinates.
export const IMAGE_PINS_KEY='computer-use-image-pins-v1'
const PIN='cu_browser_image_pin'
const parse=s=>{try{return typeof s==='string'?JSON.parse(s):s}catch{return null}}
const valid=a=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).every(k=>['event_seq','pinned'].includes(k))&&Number.isSafeInteger(a.event_seq)&&a.event_seq>=0&&typeof a.pinned==='boolean'
export function validateImagePin(pins,history,args){
 if(!valid(args))throw Error('Expected event_seq and pinned boolean')
 if(pins.limited||Object.keys(pins.calls).length+(pins.completed??[]).length>=1024)throw Error('Image pin tracking limit reached')
 const image=recallImage(history,{event_seq:args.event_seq})
 if(!image.ok)throw Error('Only a recorded screenshot in this session can be pinned')
 if(args.pinned&&!pins.pinned.includes(args.event_seq)&&pins.pinned.length>=64)throw Error('Image pin limit reached')
 return {accepted:true,status:'pending_recording',event_seq:args.event_seq,pinned:args.pinned,message:'Read cu_browser_image_pins to confirm recording. Pins affect only the optional plugin image window; host or other offload policies may still remove images. Old coordinates stay invalid.'}
}
export function imagePinsDefinition(){return{
 key:IMAGE_PINS_KEY,stateVersion:1,
 init:()=>({pinned:[],calls:{},completed:[],receipts:[],limited:false}),
 stateSchema:{parse(s){if(!s||!Array.isArray(s.pinned)||s.pinned.length>64||s.pinned.some(n=>!Number.isSafeInteger(n)||n<0)||!s.calls||Object.keys(s.calls).length>1024||!Array.isArray(s.receipts)||s.receipts.length>32||(s.completed!==undefined&&(!Array.isArray(s.completed)||s.completed.length>1024||s.completed.some(id=>typeof id!=='string'))))throw Error('Invalid image pins checkpoint');return s}},
 apply(state,event){
  const start=event.type==='tool/call'||event.type==='tool/ptc-dispatch-start'
  if(start&&event.data?.name===PIN){
   const id=event.data.callId??event.data.subCallId
   if(typeof id!=='string')return state
   if((state.completed??[]).includes(id)||Object.hasOwn(state.calls,id))return state
   if(Object.keys(state.calls).length+(state.completed??[]).length>=1024)return {...state,limited:true}
   const raw=event.data.arguments
   const args=typeof raw==='string'&&raw.length>4096?null:parse(raw)
   return {...state,calls:{...state.calls,[id]:args}}
  }
  let id,content,isError
  if(event.type==='tool/result'&&event.surfaceOp==='append'){id=event.data?.message?.toolCallId;content=event.data?.message?.content;isError=event.data?.message?.isError}
  else if(event.type==='tool/ptc-dispatch'){id=event.data?.subCallId;content=event.data?.content;isError=event.data?.isError}
  else return state
  if(!Object.hasOwn(state.calls,id)||state.receipts.some(r=>r.call_id===id))return state
  const args=state.calls[id],blocks=Array.isArray(content)?content.filter(b=>b.type==='text'):[]
  const response=blocks.length===1?parse(blocks[0].text):null
  const calls={...state.calls};delete calls[id]
  const completed=[...(state.completed??[]),id]
  if(isError||!valid(args)||response?.accepted!==true||response.event_seq!==args.event_seq||response.pinned!==args.pinned)return {...state,calls,completed}
  let pinned=state.pinned.filter(seq=>seq!==args.event_seq),status='committed'
  if(args.pinned){if(pinned.length>=64){pinned=state.pinned;status='rejected_limit'}else pinned=[...pinned,args.event_seq]}
  return {...state,calls,completed,pinned,receipts:[...state.receipts,{call_id:id,event_seq:event.seq,target_seq:args.event_seq,pinned:args.pinned,status}].slice(-32)}
 }
}}
export function installImagePins(ctx,config){
 if(!config.historyEnabled||!config.imagePinsEnabled)return
 ctx.inject(['sessionProjections'],scoped=>{
  scoped.sessionProjections.register(imagePinsDefinition())
  const get=exec=>{exec.signal.throwIfAborted();if(!exec.agent?.session)throw Error('Image pins require a DSH session');return scoped.sessionProjections.stateOf(exec.agent.session,IMAGE_PINS_KEY)}
  const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}
  scoped.tools.register({name:PIN,description:'Record a retention preference for an already recorded screenshot in this session. Pins affect only the optional plugin image window; other offload policies can still remove images. Read cu_browser_image_pins to confirm it was committed. Historical images never validate old coordinates.',parameters:{type:'object',properties:{event_seq:{type:'integer',minimum:0},pinned:{type:'boolean'}},required:['event_seq','pinned'],additionalProperties:false},output,isConcurrencySafe:()=>false,
   async execute(args,exec){
    const pins=get(exec),history=scoped.sessionProjections.stateOf(exec.agent.session,HISTORY_KEY),result=validateImagePin(pins,history,args)
    if(args.pinned){
     if(typeof scoped.attachments?.readImage!=='function')throw Error('Attachment provider cannot verify this image')
     try{await scoped.attachments.readImage(recallImage(history,args).image_attachment,exec.signal)}catch{exec.signal.throwIfAborted();throw Error('Image attachment is missing or cannot be verified')}
     exec.signal.throwIfAborted()
    }
    return result
   }})
  scoped.tools.register({name:'cu_browser_image_pins',description:'Read current session screenshot pins and recent commit receipts. Pins are retention preferences, not proof of business completion.',parameters:{type:'object',properties:{},additionalProperties:false},output,isConcurrencySafe:()=>true,
   execute(args,exec){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)throw Error('No arguments expected');const s=get(exec);return {ok:true,pinned:s.pinned,receipts:s.receipts,tracking_limited:s.limited,plugin_window_configured:config.imageWindowEnabled,warning:'Pins affect only the optional plugin image window. Host or other offload policies may still remove images.'}}})
 })
}
