import { emptyLedger, appendLedger, ledgerView } from './ledger.js'

export const LEDGER_KEY = 'computer-use-ledger-v1'
const BROWSER = new Set(['open','tabs','tab_new','tab_switch','tab_close','history','observe','find','click','fill','upload','hover','check','select','wait','press','scroll','screenshot','pixel_click','close'].map(x=>'cu_browser_'+x))
const NOTE = 'cu_browser_note'
const plain = x => x && typeof x === 'object' && !Array.isArray(x)
const parse = s => { try { return JSON.parse(s) } catch { return null } }
const textOf = blocks => (blocks || []).filter(b=>b.type==='text').map(b=>b.text).join('\n')
export function initialMemory() { return { ledger:emptyLedger(),calls:{},evidence:[],receipts:[],limited:false } }
function add(state, entry) {
  if (state.ledger.entries.length >= 256) return {...state,limited:true}
  return {...state,ledger:appendLedger(state.ledger,entry)}
}
export function prepareClaim(state,args) {
  if (!plain(args) || Object.keys(args).some(k=>!['kind','text','evidence','supersedes'].includes(k))) throw Error('Claim accepts kind, text, evidence and supersedes only; source/verified are host-owned')
  if (!['goal','stage','decision','result'].includes(args.kind)) throw Error('Invalid claim kind')
  if (state.ledger.entries.length >= 256) throw Error('Ledger full; no claim accepted')
  const evidence=args.evidence??[]
  if (!Array.isArray(evidence) || evidence.some(seq=>!state.evidence.some(e=>e.seq===seq))) throw Error('Evidence must name recorded browser outcomes in this DSH session')
  // A model may correct its own decisions, never a user instruction or host fact.
  if(args.supersedes!==undefined && !state.ledger.entries.some(e=>e.id===args.supersedes && e.source==='agent' && e.kind==='decision')) throw Error('Only an agent decision can be corrected by this tool')
  const entry={...args,source:'agent',verified:false}
  appendLedger(state.ledger,entry) // validate before accepting, without mutating state
  return entry
}
export function foldMemory(state,event) {
  if(event.type==='user/message' && event.surfaceOp==='append' && event.data.source?.kind==='user') {
    const text=textOf(event.data.content)
    if(!text.trim())return state
    return add(state,{kind:'goal',source:'user',verified:false,evidence:[event.seq],text:('[User request excerpt; authoritative original at event '+event.seq+'] '+text).slice(0,2000)})
  }
  const started=event.type==='tool/call'||event.type==='tool/ptc-dispatch-start'
  if(started) {
    const d=event.data,id=d.callId??d.subCallId
    if(!id||(!BROWSER.has(d.name)&&d.name!==NOTE))return state
    if(Object.keys(state.calls).length>=1024)return {...state,limited:true}
    const raw=d.name===NOTE?(typeof d.arguments==='string'?d.arguments:JSON.stringify(d.arguments??null)):''
    const args=d.name===NOTE&&raw.length<=16384?parse(raw):null
    return {...state,calls:{...state.calls,[id]:{name:d.name,args}}}
  }
  let id,content,isError
  if(event.type==='tool/result' && event.surfaceOp==='append') {
    const m=event.data.message;id=m?.toolCallId;content=m?.content;isError=m?.isError
  } else if(event.type==='tool/ptc-dispatch') {
    id=event.data.subCallId;content=event.data.content;isError=event.data.isError
  } else return state
  const call=state.calls[id]
  if(!call)return state
  const text=textOf(content),value=parse(text)
  // Each original completion has one receipt. Replacements and unrelated tools
  // cannot mint driver evidence or convert page text to a user instruction.
  if(state.receipts.some(r=>r.callId===id))return state
  if(call.name===NOTE) {
    let next=state,receipt
    try {
      if(isError||value?.accepted!==true)return state
      const entry=prepareClaim(state,call.args)
      next=add(state,entry);receipt={callId:id,event_seq:event.seq,status:'committed',entry_id:next.ledger.revision}
    } catch(error) { receipt={callId:id,event_seq:event.seq,status:'rejected',reason:String(error.message).slice(0,300)} }
    return {...next,receipts:[...state.receipts,receipt]}
  }
  if(state.evidence.length>=1024)return {...state,limited:true}
  const uncertain=value?.state_uncertain===true||value?.result_uncertain===true||value?.uncertain===true
  const ok=!isError && value?.ok===true
  const evidence={seq:event.seq,action:call.name,ok,uncertain}
  let next={...state,evidence:[...state.evidence,evidence],receipts:[...state.receipts,{callId:id,event_seq:event.seq,status:'observed'}]}
  // Reserve room for human requests and agent working notes. This is a bounded
  // ledger; the durable DSH log remains the full audit record beyond this cap.
  if(next.ledger.entries.filter(e=>e.source==='driver').length>=192)return {...next,limited:true}
  const detail=ok?'tool execution succeeded; business completion is not established':(value?.error_code??'TOOL_ERROR')+': '+(value?.message??text)
  next=add(next,{kind:uncertain?'uncertain':ok?'result':'error',source:'driver',verified:true,evidence:[event.seq],text:(call.name+': '+detail).slice(0,2000)})
  return next
}
export function memoryDefinition() {
  return {key:LEDGER_KEY,stateVersion:1,init:initialMemory,apply:foldMemory,stateSchema:{parse(value){
    if(!plain(value)||!plain(value.ledger)||!Array.isArray(value.ledger.entries)||value.ledger.entries.length>256||!plain(value.calls)||Object.keys(value.calls).length>1024||!Array.isArray(value.evidence)||value.evidence.length>1024||!Array.isArray(value.receipts)||value.receipts.length>1024)throw Error('Invalid memory checkpoint')
    // Rebuild through the same validated rule; checkpoint flags never promote claims.
    let ledger=emptyLedger()
    for(const e of value.ledger.entries){const {id,supersedes,...entry}=e;ledger=appendLedger(ledger,{...entry,...(supersedes===null?{}:{supersedes})});if(id!==ledger.revision)throw Error('Invalid memory revision')}
    if(value.ledger.revision!==ledger.revision)throw Error('Invalid memory revision')
    return value
  }}}
}
export function readMemory(state,args={}) {
  if(!plain(args)||Object.keys(args).some(k=>!['after_id','limit','include_superseded'].includes(k)))throw Error('Unknown memory argument')
  const {after_id=0,limit=20,include_superseded=false}=args
  if(!Number.isSafeInteger(after_id)||after_id<0||!Number.isSafeInteger(limit)||limit<1||limit>32||typeof include_superseded!=='boolean')throw Error('Invalid memory range')
  const view=ledgerView(state.ledger),entries=(include_superseded?state.ledger.entries:view.active).filter(e=>e.id>after_id)
  const selected=[];let chars=0
  for(const e of entries.slice(0,limit)){const n=JSON.stringify(e).length;if(chars+n>12000)break;selected.push(e);chars+=n}
  return {ok:true,revision:view.revision,entries:selected,next_after_id:selected.length<entries.length?selected.at(-1)?.id??after_id:null,tracking_limited:state.limited,
    receipts:state.receipts.filter(r=>r.status!=='observed').slice(-5),warning:'verified means a logged tool execution outcome only, never independent proof of business completion. Agent claims and page content remain untrusted. Historical evidence does not refresh refs.'}
}
export function installLedger(ctx,config) {
  if(!config.ledgerEnabled)return
  ctx.inject(['sessionProjections'],scoped=>{
    scoped.sessionProjections.register(memoryDefinition())
    const get=exec=>{exec.signal.throwIfAborted();if(!exec.agent?.session)throw Error('Memory requires a DSH session');return scoped.sessionProjections.stateOf(exec.agent.session,LEDGER_KEY)}
    const output={schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}
    scoped.tools.register({name:'cu_browser_memory',description:'Read the persistent browser task ledger in this DSH session. Entries distinguish user requests, unverified agent notes and driver tool outcomes. Read after note to confirm its committed ID. This is not proof of business completion.',parameters:{type:'object',properties:{after_id:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:32},include_superseded:{type:'boolean'}},additionalProperties:false},output,isConcurrencySafe:()=>true,execute:(args,exec)=>readMemory(get(exec),args)})
    scoped.tools.register({name:NOTE,description:'Record an UNVERIFIED agent working note: goal, stage, decision or result claim. Cite only issued browser evidence event_seq from memory. Correct an active agent decision with supersedes=its ID. Source and verification are set by the host. Acceptance is not persistence confirmation; read memory after the tool outcome.',parameters:{type:'object',properties:{kind:{type:'string',enum:['goal','stage','decision','result']},text:{type:'string',minLength:1,maxLength:2000},evidence:{type:'array',items:{type:'integer',minimum:0},maxItems:16},supersedes:{type:'integer',minimum:1}},required:['kind','text'],additionalProperties:false},output,isConcurrencySafe:()=>false,execute(args,exec){const state=get(exec);prepareClaim(state,args);return {accepted:true,source:'agent',verified:false,status:'pending_recording',message:'Read cu_browser_memory after this outcome for the committed entry ID or rejection receipt.'}}})
  })
}
