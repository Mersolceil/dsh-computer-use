import { initialMemory, foldMemory } from '../src/ledger-host.js'
import { ledgerView } from '../src/ledger.js'
import { imagePinsDefinition } from '../src/image-pins.js'
import { historyDefinition } from '../src/history.js'
import { isDeepStrictEqual } from 'node:util'

const json=s=>{try{return JSON.parse(s)}catch{return null}}
const pathname=s=>{try{return new URL(s,'http://invalid.local').pathname}catch{return null}}
// Native tool results and PTC sub-dispatches are counted separately, never
// from the root run_code printout, which can repeat or fabricate content.
function outcomes(events,name){
 const calls=new Set(events.filter(e=>e.type==='tool/call'&&e.data?.name===name).map(e=>e.data.callId))
 const seen=new Set()
 return events.flatMap(e=>{
  if(e.type==='tool/result'&&e.surfaceOp==='append'&&calls.has(e.data?.message?.toolCallId)){const id=e.data.message.toolCallId,key=`native:${id}`;if(seen.has(key))return [];seen.add(key);return [{seq:e.seq,mode:'native',isError:!!e.data.message.isError,content:e.data.message.content??[]}]}
  if(e.type==='tool/ptc-dispatch'&&e.data?.name===name){const {rootCallId,subCallId}=e.data;if(typeof rootCallId!=='string'||typeof subCallId!=='string')return [];const key=JSON.stringify(['ptc',rootCallId,subCallId]);if(seen.has(key))return [];seen.add(key);return [{seq:e.seq,mode:'ptc',isError:!!e.data.isError,content:e.data.content??[]}]}
  return []
 }).map(o=>({...o,value:json(o.content.find(b=>b.type==='text')?.text)}))
}
export function evaluateLongContext({events,server,answer,code,exitCode,timedOut}){
 if(!Array.isArray(events)||!server||typeof answer!=='string'||typeof code!=='string')throw Error('Invalid long-context evidence')
 let memory=initialMemory(),pins=imagePinsDefinition().init(),history=historyDefinition({ptcEnabled:true}).init()
 const pinDef=imagePinsDefinition(),historyDef=historyDefinition({ptcEnabled:true})
 for(const event of events){memory=foldMemory(memory,event);pins=pinDef.apply(pins,event);history=historyDef.apply(history,event)}
 const active=ledgerView(memory.ledger).active,decisions=memory.ledger.entries.filter(e=>e.kind==='decision')
 const error=memory.ledger.entries.find(e=>e.kind==='error'&&e.text.includes('ORIGIN_DENIED'))
 const stateMessages=events.filter(e=>e.type==='user/message'&&e.data?.source?.kind==='computer-use-state').map(e=>({seq:e.seq,value:json(e.data.content?.find(b=>b.type==='text')?.text)})).filter(x=>x.value)
 const snapshot=stateMessages.at(-1),summary=snapshot?.value?.summary,lastClick=outcomes(events,'cu_browser_click').at(-1)?.seq
 const recalls=outcomes(events,'cu_browser_recall').filter(o=>!o.isError&&o.value?.ok&&typeof o.value.content_text==='string')
 const codeRecalls=recalls.filter(o=>o.value.content_text.includes(code)&&history.rows.some(r=>{
  if(r.seq!==o.value.source_event_seq||r.seq>=o.seq||r.name!=='cu_browser_observe')return false
  const content=r.mode==='ptc-image'?r.data?.content:r.data?.message?.content
  const original=json(content?.find(b=>b.type==='text')?.text)
  return typeof original?.url==='string'&&pathname(original.url)==='/tab-detail'&&JSON.stringify(original).includes(code)
 }))
 const imageRecalls=outcomes(events,'cu_browser_image_recall').filter(o=>!o.isError&&o.value?.ok&&o.content.some(b=>b.type==='image')&&(o.mode==='native'||events.some(e=>e.type==='user/message'&&e.surfaceOp==='append'&&e.seq>o.seq&&e.data?.source?.kind==='ptc-mode'&&isDeepStrictEqual(e.data?.content,o.content))))
 const offloaded=events.filter(e=>e.type==='image/offload').flatMap(e=>(e.data?.targets??[]).map(target=>({...target,eventSeq:e.seq})))
 const lineage=(row,before=Infinity)=>{const seqs=new Set([row.seq]);for(const e of events){if(e.seq>=before)continue;const op=e.surfaceOp;if(op?.op==='replace'&&op.startSeq===op.endSeq&&seqs.has(op.startSeq)&&e.sourceEventSeqs?.length===1&&e.sourceEventSeqs[0]===op.startSeq)seqs.add(e.seq)}return seqs}
 const firstScreenshot=history.rows.find(r=>{
  if(r.name!=='cu_browser_screenshot')return false
  const content=r.mode==='ptc-image'?r.data?.content:r.data?.message?.content
  return content?.some(b=>b.type==='image'&&b.attachment?.attachmentId)
 })
 const reissuedOffloaded=imageRecalls.some(o=>history.rows.some(r=>{
  if(r.seq!==o.value.source_event_seq||r.name!=='cu_browser_screenshot'||pins.pinned.includes(r.seq))return false
  const index=o.value.image_index
  if(!Number.isSafeInteger(index)||index<0)return false
  const content=r.mode==='ptc-image'?r.data?.content:r.data?.message?.content
  const original=content?.filter(b=>b.type==='image')[index],returned=o.content.find(b=>b.type==='image')
  return !!original?.attachment&&r.seq<o.seq&&isDeepStrictEqual(original.attachment,returned?.attachment)&&offloaded.some(t=>t.eventSeq>r.seq&&t.eventSeq<o.seq&&lineage(r,t.eventSeq).has(t.seq)&&t.imageIndexes?.includes(index))
 }))
 const validObservations=outcomes(events,'cu_browser_observe').filter(o=>!o.isError&&o.value?.ok===true).length
 const retentionSteps=new Set();let step
 for(const e of events){if(e.type==='step/start')step=`${e.data?.turn}:${e.data?.step}`;if(e.type==='compaction/prune'&&step&&e.data?.shadowedSeqs?.some(seq=>history.rows.some(r=>r.seq===seq)))retentionSteps.add(step)}
 const currentDecision=active.find(e=>e.kind==='decision'&&e.text.includes('最终方案'))
 const checks={
  completed:exitCode===0&&!timedOut,
  observed_50:validObservations>=50,
  repeated_retention:retentionSteps.size>=3,
  first_error:!!error&&!!summary?.first_error?.text?.includes('ORIGIN_DENIED'),
  decision_correction:decisions.length>=2&&!!currentDecision&&decisions.some(e=>e.id===currentDecision.supersedes),
  snapshot_current_decision:!!summary?.decisions?.some(e=>e?.id===currentDecision?.id),
  snapshot_stage_after_save:!!summary?.current_stage?.text?.includes('准备保存一次')&&Number.isSafeInteger(lastClick)&&snapshot.seq>lastClick,
  random_code_recalled:codeRecalls.length>0,
  pin_committed:!!firstScreenshot&&pins.pinned.includes(firstScreenshot.seq),
  pinned_screenshot_preserved:!!firstScreenshot&&!offloaded.some(t=>lineage(firstScreenshot,t.eventSeq).has(t.seq)),
  offloaded_image_reissued:reissuedOffloaded,
  tracking_complete:!memory.limited&&!pins.limited,
  server_exactly_once:server.submissions===1&&server.last?.title===code&&server.last?.description==='长流程验收',
  answer_facts:answer.includes(code)&&answer.includes('ORIGIN_DENIED')&&answer.includes('最终方案'),
 }
 return {success:Object.values(checks).every(Boolean),checks,successful_observations:validObservations,retention_steps:retentionSteps.size,compaction_events:events.filter(e=>e.type==='compaction/prune').length,image_offload_events:events.filter(e=>e.type==='image/offload').length,ledger_tracking_limited:memory.limited}
}
