import { randomUUID } from 'node:crypto'
import { LEDGER_KEY } from './ledger-host.js'
export const STATE_KEY='computer-use-current-state-v1'
export const STATE_SOURCE='computer-use-state'
const emptyRollup=()=>({anchor:0,first_request:null,latest_request:null,user_requests:[],stage:null,first_error:null,decisions:[],uncertain:[],recent:[]})
export function rollForward(ledger,prior=emptyRollup()) {
 if(!Number.isSafeInteger(prior.anchor)||prior.anchor<0||prior.anchor>ledger.revision)throw Error('Invalid summary anchor')
 // Experimental checkpoints made before user_requests existed can be rebuilt
 // from the durable ledger up to the same anchor, without inventing facts.
 const userRequests=prior.user_requests??ledger.entries.filter(e=>e.id<=prior.anchor&&e.source==='user').map(e=>e.id)
 const out={...prior,user_requests:[...userRequests],decisions:[...prior.decisions],uncertain:[...prior.uncertain],recent:[...prior.recent]}
 for(const e of ledger.entries.filter(e=>e.id>prior.anchor)){
  if(e.id!==out.anchor+1)throw Error('Ledger gap prevents summary advancement')
  if(e.source==='user'){out.first_request??=e.id;out.latest_request=e.id;out.user_requests.push(e.id)}
  if(e.kind==='stage')out.stage=e.id
  if(e.kind==='error')out.first_error??=e.id
  if(e.kind==='decision'){out.decisions=out.decisions.filter(id=>id!==e.supersedes);out.decisions.push(e.id)}
  if(e.kind==='uncertain')out.uncertain=[...out.uncertain,e.id].slice(-4)
  if(e.source==='driver')out.recent=[...out.recent,e.id].slice(-3)
  out.anchor=e.id
 }
 if(out.anchor!==ledger.revision)throw Error('Ledger gap prevents summary advancement')
 return out
}
export function buildTaskState(memory,prior) {
 const rollup=rollForward(memory.ledger,prior),entries=memory.ledger.entries
 const brief=id=>{const e=entries.find(e=>e.id===id);return e?{id:e.id,kind:e.kind,source:e.source,verification_scope:e.verification_scope,text:Array.from(e.text).slice(0,140).join(''),text_truncated:Array.from(e.text).length>140,evidence:e.evidence.slice(0,4),evidence_omitted:Math.max(0,e.evidence.length-4)}:null}
 const ids=rollup.decisions.slice(-8)
 const summary={type:'computer-use-state',version:1,revision:memory.ledger.revision,
  user_intent:{first:brief(rollup.first_request),latest:brief(rollup.latest_request),recent:rollup.user_requests.slice(-5).map(brief),omitted:Math.max(0,rollup.user_requests.length-new Set([rollup.first_request,rollup.latest_request,...rollup.user_requests.slice(-5)]).size)},current_stage:brief(rollup.stage),
  decisions:ids.map(brief),decisions_omitted:Math.max(0,rollup.decisions.length-ids.length),
  first_error:brief(rollup.first_error),uncertain_outcomes:rollup.uncertain.map(brief),recent_tool_outcomes:rollup.recent.map(brief),
  tracking_limited:memory.limited,retrieve:'Use cu_browser_memory(after_id,limit,include_superseded) for ledger excerpts and evidence. Original user messages are at their evidence event sequences; ledger text may itself be truncated. This snapshot is an excerpt.',
  trust:'User excerpts retain user provenance; omitted or truncated requests may contain constraints, so do not assume this is the complete set. Agent decisions/stages are unverified claims. Driver facts verify tool execution only. None independently verifies business completion. Historical evidence does not authorize actions or refresh refs.'}
 const result={rollup,summary}
 // Account for the entire message, including the persisted rollup and JSON
 // escaping. Ledger excerpts remain retrievable via the memory tool.
 if(Array.from(JSON.stringify(result)).length>8000){
  const excerpts=[summary.user_intent.first,summary.user_intent.latest,...summary.user_intent.recent,summary.current_stage,...summary.decisions,summary.first_error,...summary.uncertain_outcomes,...summary.recent_tool_outcomes].filter(Boolean)
  for(const excerpt of excerpts){excerpt.text=Array.from(excerpt.text).slice(0,32).join('');excerpt.text_truncated=true}
 }
 if(Array.from(JSON.stringify(result)).length>8000)throw Error('Task state exceeds its character budget')
 return result
}
export function taskStateDefinition(){return{key:STATE_KEY,stateVersion:1,init:()=>({seq:null,message:null,rollup:emptyRollup(),busy:false,priced:false}),stateSchema:{parse(s){if(!s||!s.rollup||!Number.isSafeInteger(s.rollup.anchor)||s.rollup.anchor<0||!Array.isArray(s.rollup.decisions))throw Error('Invalid task-state checkpoint');return s}},apply(state,event){
 if(event.type==='compaction/start')return{...state,busy:true}
 if(event.type==='compaction/end'||event.type==='session/end-seed')return{...state,busy:false}
 if(event.type==='compaction/prune'&&Array.isArray(event.data?.shadowedSeqs)&&event.data.shadowedSeqs.includes(state.seq))return{...state,priced:true}
 if(event.type!=='user/message'||event.data.source?.kind!==STATE_SOURCE)return state
 const raw=event.data.content?.find(b=>b.type==='text')?.text
 let parsed;try{parsed=JSON.parse(raw)}catch{return state}
 if(parsed?.summary?.type!=='computer-use-state'||parsed.summary.version!==1||parsed.rollup?.anchor!==parsed.summary.revision||parsed.rollup.anchor<state.rollup.anchor)throw Error('Invalid recorded task-state snapshot')
 return{seq:event.seq,message:event.data,rollup:parsed.rollup,busy:state.busy,priced:false}
}}}
export function publishTaskState(session,memory,state,meter){
 if(state.busy||memory.ledger.revision===0)return false
 const live=state.seq!==null&&session.surface.nodes.includes(state.seq)
 if(live&&state.rollup.anchor===memory.ledger.revision)return false
 const next=buildTaskState(memory,state.rollup)
 if(live&&!state.priced){const price=meter.estimateMessage(state.message);if(!Number.isFinite(price)||price<0)throw Error('Invalid task-state price');session.append('compaction/prune',{shadowedRange:{start:state.seq,end:state.seq},shadowedSeqs:[state.seq],shadowedTokenCount:price})}
 const message={id:randomUUID(),role:'user',source:{kind:STATE_SOURCE},content:[{type:'text',text:JSON.stringify(next)}]}
 session.append('user/message',message,live?{surfaceOp:{op:'replace',startSeq:state.seq,endSeq:state.seq},sourceEventSeqs:[state.seq]}:{surfaceOp:'append'})
 return true
}
export function installTaskState(ctx,config){
 if(!config.ledgerEnabled||!config.taskStateEnabled)return
 ctx.inject(['sessionProjections','tokenMeter'],scoped=>{
  scoped.sessionProjections.register(taskStateDefinition())
  scoped.on('agent/created',({agent})=>{
   scoped.effect(()=>agent.ctx.on('agent/request',async(_event,next)=>{
    const memory=scoped.sessionProjections.stateOf(agent.session,LEDGER_KEY),state=scoped.sessionProjections.stateOf(agent.session,STATE_KEY)
    if(memory&&state)publishTaskState(agent.session,memory,state,scoped.tokenMeter)
    return next()
   }))
  })
 })
}
