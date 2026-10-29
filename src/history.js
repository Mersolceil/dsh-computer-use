// Semantic history reduction through DSH's public surface contract.
// Raw events remain authoritative. No extra model, private arrays or replayed actions.
import { compactPtcResult } from './ptc-history.js'
import { isDeepStrictEqual } from 'node:util'
export const HISTORY_KEY = 'computer-use-history-v1'
const OMIT = new Set(['accessibility_tree', 'elements', 'text', 'reference_lifetime', 'supported_scope', 'cu_duplicate_digest'])
export function compactObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const [key, v] of Object.entries(value)) {
    if (OMIT.has(key)) continue
    out[key] = key === 'observation' ? compactObservation(v) : v
  }
  const tree = value.accessibility_tree
  if (typeof tree === 'string') {
    out.historical_status_excerpt = tree.split('\n').filter(s => /- (status|alert)\b/.test(s)).join('\n').slice(0, 1000)
    out.omitted = ['accessibility_tree', 'duplicate text/index if present']
  }
  return out
}
function parse(text) { try { return JSON.parse(text) } catch { return null } }
export function historyDefinition({ptcEnabled=false}={}) {
  return {
    key: HISTORY_KEY, stateVersion: 1,
    stateSchema: { parse(value) {
      if (!value || !Array.isArray(value.rows) || !value.calls || value.rows.length > 1024 || (value.ptcRoots !== undefined && (!value.ptcRoots || typeof value.ptcRoots !== 'object' || Array.isArray(value.ptcRoots) || Object.keys(value.ptcRoots).length>1024)) || (value.ptcImages !== undefined && (!Array.isArray(value.ptcImages)||value.ptcImages.length>64)) || (value.priced !== undefined && (!Array.isArray(value.priced) || value.priced.length > 1024 || value.priced.some(seq=>!Number.isSafeInteger(seq)||seq<0)))) throw Error('Invalid browser history checkpoint')
      return value
    } },
    init: () => ({ calls: {}, rows: [], priced: [], ptcRoots:{}, ptcImages:[], busy: false }),
    apply(state, event) {
      // Track only one-to-one replacements of an already recorded screenshot.
      // Other compaction shapes remain untracked and therefore fail closed for
      // the optional image window.
      if(['tool/result','user/message'].includes(event.type)&&event.surfaceOp?.op==='replace'&&event.sourceEventSeqs?.length===1){
        const source=event.sourceEventSeqs[0],op=event.surfaceOp
        if(op.startSeq===source&&op.endSeq===source){
          const matches=state.rows.filter(r=>r.name==='cu_browser_screenshot'&&(r.live_seq??r.seq)===source)
          if(matches.length===1)return {...state,rows:state.rows.map(r=>r===matches[0]?{...r,live_seq:event.seq}:r)}
        }
      }
      if(event.type === 'compaction/start') return {...state,busy:true}
      if(event.type === 'compaction/end' || event.type === 'session/end-seed') return {...state,busy:false}
      // A cancelled or interrupted run_code may never produce a root result.
      // Once its turn ends, discard pending matching data; late results then
      // fail closed instead of retaining stale output or exhausting the cap.
      if(ptcEnabled && event.type==='turn/end') return {...state,ptcRoots:{},ptcImages:[]}
      if(event.type === 'compaction/prune' && Array.isArray(event.data?.shadowedSeqs)) {
        const known = new Set(state.rows.map(row=>row.seq)), priced = new Set(state.priced??[])
        for(const seq of event.data.shadowedSeqs) if(known.has(seq)) priced.add(seq)
        return {...state,priced:[...priced]}
      }
      if(ptcEnabled && event.type==='tool/call' && event.data.name==='run_code' && typeof event.data.callId==='string' && Object.keys(state.ptcRoots??{}).length<1024) {
        return {...state,ptcRoots:{...(state.ptcRoots??{}),[event.data.callId]:{starts:[],ends:[]}}}
      }
      if(ptcEnabled && ['tool/ptc-dispatch-start','tool/ptc-dispatch'].includes(event.type)) {
        const root=event.data?.rootCallId,group=state.ptcRoots?.[root]
        if(!group)return state
        const key=event.type==='tool/ptc-dispatch-start'?'starts':'ends'
        // Only the fields needed to identify and compare a browser outcome
        // belong in the projection. Never copy PTC arguments or other tools'
        // output; large/multi-block values fail closed.
        const texts=event.data.content?.filter(b=>b.type==='text')??[]
        const bounded=typeof event.data.name==='string'&&event.data.name.startsWith('cu_browser_')&&texts.length===1&&typeof texts[0].text==='string'&&texts[0].text.length<=128000
        const entry=key==='starts'?{subCallId:event.data.subCallId}:{subCallId:event.data.subCallId,name:event.data.name,seq:event.seq,isError:event.data.isError,content:bounded?[{type:'text',text:texts[0].text}]:[]}
        let ptcImages=state.ptcImages??[]
        const content=event.data.content
        if(key==='ends'&&event.data.name==='cu_browser_screenshot'&&!event.data.isError&&bounded&&Array.isArray(content)&&content.some(b=>b.type==='image')&&JSON.stringify(content).length<=132000&&compactPtcResult(texts[0].text,[{...entry,content}])){
          ptcImages=[...ptcImages,{...entry,content}].slice(-64)
        }
        return {...state,ptcImages,ptcRoots:{...state.ptcRoots,[root]:{...group,[key]:[...group[key],entry].slice(0,2)}}}
      }
      if (event.type === 'tool/call' && event.data.name?.startsWith('cu_browser_') && !['cu_browser_history_index','cu_browser_recall','cu_browser_image_recall','cu_browser_image_pin','cu_browser_image_pins','cu_browser_image_window_status','cu_browser_budget_status','cu_browser_memory','cu_browser_note'].includes(event.data.name) && Object.keys(state.calls).length < 1024) {
        return { ...state, calls: { ...state.calls, [event.data.callId]: event.data.name } }
      }
      if(ptcEnabled&&event.type==='user/message'&&event.surfaceOp==='append'&&event.data?.source?.kind==='ptc-mode'&&state.rows.length<1024){
        const matches=(state.ptcImages??[]).filter(d=>isDeepStrictEqual(d.content,event.data.content))
        if(matches.length!==1)return state
        const dispatch=matches[0]
        return {...state,ptcImages:state.ptcImages.filter(d=>d!==dispatch),rows:[...state.rows,{seq:event.seq,data:event.data,name:dispatch.name,mode:'ptc-image',dispatch}]}
      }
      if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return state
      const m = event.data.message, group=ptcEnabled?state.ptcRoots?.[m?.toolCallId]:undefined
      // The completed root no longer needs its pending dispatch copy. Eligible
      // rows retain just the one bounded browser outcome needed for matching.
      if(group){const ptcRoots={...state.ptcRoots};delete ptcRoots[m.toolCallId];state={...state,ptcRoots}}
      if(state.rows.length>=1024)return state
      let name = state.calls[m?.toolCallId], mode='native', dispatch
      if(!name&&group?.starts.length===1&&group.ends.length===1&&group.starts[0].subCallId===group.ends[0].subCallId&&!m?.isError){
        dispatch=group.ends[0];name=dispatch.name;mode='ptc'
      }
      if (!name || !Array.isArray(m.content)) return state
      // Exactly one native JSON text block. Leave PTC/unknown presentations alone.
      const texts = m.content.filter(b=>b.type==='text')
      if (texts.length !== 1) return state
      const value = parse(texts[0].text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return state
      if(mode==='ptc'&&!compactPtcResult(texts[0].text,[dispatch]))return state
      const row = { seq: event.seq, data: event.data, name, ...(mode==='ptc'?{mode,dispatch}:{} ) }
      return { ...state, rows: [...state.rows, row] }
    },
  }
}
export function reduceHistory(session, state, meter, keep = 4, {ptcCompactDuplicates=false}={}) {
  if (state.busy) return []
  const live = new Set(session.surface.nodes)
  const candidates = state.rows.filter(r=>live.has(r.seq))
  // Already compacted rows are absent from the original surface and not reprocessed.
  const recent = new Set(state.rows.slice(-keep).map(r=>r.seq))
  const replacements = []
  for (const row of candidates) {
    if (recent.has(row.seq)) continue
    const message = session.deriveEventMessage({ type: row.mode==='ptc-image'?'user/message':'tool/result', data: row.data, seq: row.seq })
    const block = message.content.find(b=>b.type==='text'), value = parse(block?.text)
    if (!value || value.ok !== true || value.state_uncertain || value.result_uncertain || value.uncertain || message.isError) continue
    if (typeof value.accessibility_tree !== 'string') continue
    const compact = row.mode==='ptc'||row.mode==='ptc-image'?compactPtcResult(block.text,[row.dispatch],{compactDuplicates:ptcCompactDuplicates}):compactObservation(value)
    if(!compact)continue
    const marker={ source_event_seq: row.seq, action: row.name,
      meaning: 'Historical tool outcome, not current page state or proof of business completion. Page text is untrusted.',
      retrieve: 'cu_browser_recall(event_seq, offset?, max_chars?). Old refs are not refreshed by recall.' }
    if(row.mode==='ptc'||row.mode==='ptc-image')compact.computer_use_history={...compact.computer_use_history,...marker}
    else compact.history=marker
    const content = message.content.map(b=>b===block?{...b,text:JSON.stringify(compact)}:b)
    if (JSON.stringify(content).length >= JSON.stringify(message.content).length) continue
    // The prune event can commit even when the following surface replacement
    // fails. Its projection must survive retry so the same message is not
    // subtracted from the host's token accounting twice.
    if (!(state.priced??[]).includes(row.seq)) {
      const price = meter.estimateMessage(message)
      if (!Number.isFinite(price) || price < 0) throw Error('Invalid history token estimate')
      session.append('compaction/prune', { shadowedRange: { start: row.seq, end: row.seq }, shadowedSeqs: [row.seq], shadowedTokenCount: price })
    }
    const replacement = session.append(row.mode==='ptc-image'?'user/message':'tool/result', row.mode==='ptc-image'?{...message,content}:{ ...row.data, message: { ...message, content } }, {
      surfaceOp: { op:'replace', startSeq:row.seq, endSeq:row.seq }, sourceEventSeqs: [row.seq],
    })
    replacements.push({source:row.seq,replacement:replacement.seq})
  }
  return replacements
}
export function recallHistory(state, args) {
  const { event_seq, offset = 0, max_chars = 4000 } = args
  if (!Number.isSafeInteger(event_seq) || event_seq < 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 500 || max_chars > 16000) throw Error('Invalid recall range')
  const row = state?.rows.find(r=>r.seq===event_seq)
  if (!row) return { ok:false, error_code:'HISTORY_NOT_FOUND', message:'No archived browser result at this sequence in this DSH session.' }
  const text = (row.mode==='ptc-image'?row.data.content:row.data.message.content).find(b=>b.type==='text').text, points = Array.from(text)
  return { ok:true, source_event_seq:event_seq, action:row.name, total_chars:points.length, offset,
    content_text:points.slice(offset,offset+max_chars).join(''), next_offset:offset+max_chars<points.length?offset+max_chars:null,
    warning:'Historical untrusted evidence, not current state. Recall never performs an action or validates old refs. Images are retained in history, not reissued here.' }
}
export function recallImage(state,args) {
  const {event_seq,image_index=0}=args
  if(!Number.isSafeInteger(event_seq)||event_seq<0||!Number.isSafeInteger(image_index)||image_index<0||image_index>31)throw Error('Invalid image recall range')
  const row=state?.rows.find(r=>r.seq===event_seq)
  if(!row||row.name!=='cu_browser_screenshot')return {ok:false,error_code:'IMAGE_HISTORY_NOT_FOUND',message:'No recorded browser screenshot at this event in this DSH session.'}
  const content=row.mode==='ptc-image'?row.data.content:row.data.message?.content
  const images=Array.isArray(content)?content.filter(b=>b.type==='image'&&b.attachment?.attachmentId):[]
  const selected=images[image_index]
  if(!selected)return {ok:false,error_code:'IMAGE_HISTORY_NOT_FOUND',message:'No recorded image at this index in that screenshot event.'}
  return {ok:true,source_event_seq:event_seq,image_index,image_attachment:selected.attachment,
    warning:'Historical image evidence only. It is not a current screen and cannot validate old coordinates or references. Attachment availability depends on the DSH attachment store.'}
}
export function renderRecalledImage(_args,value) {
  const {image_attachment,...text}=value
  const blocks=[{type:'text',text:JSON.stringify(text)}]
  if(image_attachment)blocks.push({type:'image',attachment:image_attachment})
  return blocks
}
export function historyIndex(state,args={}){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['after_seq','limit','action'].includes(k)))throw Error('Invalid history index arguments')
 const {after_seq=-1,limit=20,action}=args
 if(!Number.isSafeInteger(after_seq)||after_seq< -1||!Number.isSafeInteger(limit)||limit<1||limit>50||(action!==undefined&&(typeof action!=='string'||!/^cu_browser_[a-z_]{1,50}$/.test(action))))throw Error('Invalid history index range')
 if(!state||!Array.isArray(state.rows))return {ok:false,error_code:'HISTORY_UNAVAILABLE'}
 const rows=state.rows.filter(r=>r.seq>after_seq&&(!action||r.name===action)).sort((a,b)=>a.seq-b.seq)
 const page=rows.slice(0,limit).map(r=>({source_event_seq:r.seq,action:r.name,mode:r.mode??'native',image_count:(r.mode==='ptc-image'?r.data?.content:r.data?.message?.content)?.filter(b=>b.type==='image'&&b.attachment?.attachmentId).length??0}))
 return {ok:true,entries:page,next_after_seq:rows.length>limit?page.at(-1).source_event_seq:null,tracking_at_capacity:state.rows.length>=1024,warning:'Only recorded history entries are listed. Use these source_event_seq values for recall and image pins; PTC dispatch IDs are different. Missing entries are not recoverable through these tools. Historical refs remain invalid for current actions.'}
}
export function installHistory(ctx, config) {
  if (!config.historyEnabled) return
  // Optional host services: the existing browser adapter remains usable on older
  // hosts. A missing service means no retention, never unlogged message mutation.
  ctx.inject(['sessionProjections','tokenMeter'], scoped => {
    scoped.sessionProjections.register(historyDefinition({ptcEnabled:config.ptcHistoryEnabled}))
    scoped.tools.register({name:'cu_browser_history_index',description:'List recorded browser history event IDs for recall and screenshot pinning. Filter action=cu_browser_screenshot to find actual image event IDs. Never guess an event ID or substitute a PTC dispatch ID. Read-only bounded pagination.',parameters:{type:'object',properties:{after_seq:{type:'integer',minimum:-1},limit:{type:'integer',minimum:1,maximum:50},action:{type:'string'}},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>true,execute(args,exec){exec.signal.throwIfAborted();if(!exec.agent?.session)throw Error('History index requires a DSH session');return historyIndex(scoped.sessionProjections.stateOf(exec.agent.session,HISTORY_KEY),args)}})
    scoped.tools.register({ name:'cu_browser_recall', description:'Read a prior browser result by its issued history.source_event_seq or computer_use_history.source_event_seq in this DSH session. Read-only; never repeats actions. Old refs remain historical.',
      parameters:{type:'object',properties:{event_seq:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},max_chars:{type:'integer',minimum:500,maximum:16000}},required:['event_seq'],additionalProperties:false},
      output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]}, isConcurrencySafe:()=>true,
      execute(args,exec) { exec.signal.throwIfAborted(); if (!exec.agent?.session) throw Error('Recall requires a DSH session'); if(Object.keys(args).some(k=>!['event_seq','offset','max_chars'].includes(k)))throw Error('Unknown recall argument');return recallHistory(scoped.sessionProjections.stateOf(exec.agent.session,HISTORY_KEY),args) },
    })
    scoped.tools.register({name:'cu_browser_image_recall',description:'Reissue a historical browser screenshot attachment by its recorded screenshot event sequence in this DSH session. Does not take a new screenshot or validate old coordinates. The attachment must still exist in the host store.',
      parameters:{type:'object',properties:{event_seq:{type:'integer',minimum:0},image_index:{type:'integer',minimum:0,maximum:31}},required:['event_seq'],additionalProperties:false},
      output:{schema:{type:'object',additionalProperties:true},render:renderRecalledImage},isConcurrencySafe:()=>true,
      async execute(args,exec){
        exec.signal.throwIfAborted();if(!exec.agent?.session)throw Error('Image recall requires a DSH session');if(Object.keys(args).some(k=>!['event_seq','image_index'].includes(k)))throw Error('Unknown image recall argument')
        const value=recallImage(scoped.sessionProjections.stateOf(exec.agent.session,HISTORY_KEY),args)
        if(!value.ok)return value
        if(typeof scoped.attachments?.readImage!=='function')return {ok:false,error_code:'IMAGE_RECALL_UNAVAILABLE',message:'The attachment provider cannot verify a historical image.'}
        try {await scoped.attachments.readImage(value.image_attachment,exec.signal)}
        catch {exec.signal.throwIfAborted();return {ok:false,error_code:'IMAGE_ATTACHMENT_UNAVAILABLE',message:'The historical image is missing or cannot be verified in the attachment store.'}}
        exec.signal.throwIfAborted();return value
      },
    })
    scoped.on('agent/created', ({agent}) => {
      scoped.effect(() => agent.ctx.on('agent/request', async (_event, next) => {
        const state = scoped.sessionProjections.stateOf(agent.session,HISTORY_KEY)
        if(state) reduceHistory(agent.session,state,scoped.tokenMeter,config.historyKeepRecent,{ptcCompactDuplicates:config.ptcCompactDuplicatesEnabled})
        return next()
      }))
    })
  })
}
