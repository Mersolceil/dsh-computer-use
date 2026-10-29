import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateLongContext} from '../eval/long-context-check.js'

test('a fabricated final answer without tool events and server result cannot pass',()=>{
 const result=evaluateLongContext({events:[],server:{submissions:0},answer:'ABC123 ORIGIN_DENIED 最终方案',code:'ABC123',exitCode:0,timedOut:false})
 assert.equal(result.success,false);assert.equal(result.checks.answer_facts,true);assert.equal(result.checks.observed_50,false);assert.equal(result.checks.server_exactly_once,false);assert.equal(result.checks.offloaded_image_reissued,false)
})
test('PTC root printed text alone cannot fabricate completed subtool observations',()=>{
 const events=[{type:'tool/call',data:{callId:'r',name:'run_code'}},{type:'tool/result',surfaceOp:'append',data:{message:{toolCallId:'r',content:[{type:'text',text:JSON.stringify({ok:true})}]}}}]
 const result=evaluateLongContext({events,server:{submissions:1,last:{title:'ABC123',description:'长流程验收'}},answer:'ABC123 ORIGIN_DENIED 最终方案',code:'ABC123',exitCode:0,timedOut:false})
 assert.equal(result.success,false);assert.equal(result.successful_observations,0);assert.equal(result.checks.server_exactly_once,true)
})
test('PTC observation counts use completed sub-dispatches, not run_code output',()=>{
 const events=Array.from({length:50},(_,i)=>({seq:i+1,type:'tool/ptc-dispatch',data:{rootCallId:'r'+i,subCallId:'s'+i,name:'cu_browser_observe',isError:false,content:[{type:'text',text:'{"ok":true}'}]}}))
 const result=evaluateLongContext({events,server:{submissions:0},answer:'',code:'ABC123',exitCode:0,timedOut:false})
 assert.equal(result.successful_observations,50);assert.equal(result.checks.observed_50,true);assert.equal(result.success,false)
})
test('replayed duplicate tool results cannot inflate the observation count',()=>{
 const native=[{type:'tool/call',data:{callId:'same',name:'cu_browser_observe'}},...Array.from({length:50},(_,i)=>({seq:i+1,type:'tool/result',surfaceOp:'append',data:{message:{toolCallId:'same',content:[{type:'text',text:'{"ok":true}'}]}}}))]
 const ptc=Array.from({length:50},(_,i)=>({seq:i+100,type:'tool/ptc-dispatch',data:{rootCallId:'root',subCallId:'same',name:'cu_browser_observe',content:[{type:'text',text:'{"ok":true}'}]}}))
 const result=evaluateLongContext({events:[...native,...ptc],server:{submissions:0},answer:'',code:'ABC123',exitCode:0,timedOut:false})
 assert.equal(result.successful_observations,2);assert.equal(result.checks.observed_50,false)
})
test('independent evidence is required for every long-flow checkpoint',()=>{
 const events=[];let seq=0,step=0
 const add=(type,data,extra={})=>{const e={seq:++seq,type,data,...extra};events.push(e);return e}
 const tool=(name,args,value,images=[])=>{
  const id='call-'+(seq+1);add('tool/call',{callId:id,name,arguments:JSON.stringify(args)})
  return add('tool/result',{message:{toolCallId:id,content:[{type:'text',text:JSON.stringify(value)},...images]}},{surfaceOp:'append'})
 }
 add('user/message',{source:{kind:'user'},content:[{type:'text',text:'remember'}]},{surfaceOp:'append'})
 tool('cu_browser_note',{kind:'decision',text:'初始方案'},{accepted:true})
 tool('cu_browser_note',{kind:'decision',text:'最终方案',supersedes:2},{accepted:true})
 tool('cu_browser_open',{}, {ok:false,error_code:'ORIGIN_DENIED',message:'denied'})
 const image1={type:'image',attachment:{attachmentId:'sha256:first'}},image2={type:'image',attachment:{attachmentId:'sha256:second'}}
 const pinned=tool('cu_browser_screenshot',{}, {ok:true},[image1])
 tool('cu_browser_image_pin',{event_seq:pinned.seq,pinned:true},{accepted:true,event_seq:pinned.seq,pinned:true})
 const oldImage=tool('cu_browser_screenshot',{}, {ok:true},[image2])
 add('image/offload',{targets:[{seq:oldImage.seq,imageIndexes:[0]}]})
 tool('cu_browser_image_recall',{event_seq:oldImage.seq},{ok:true,source_event_seq:oldImage.seq,image_index:0},[image2])
 let original
 for(let i=0;i<50;i++){
  if(i%10===0)add('step/start',{turn:1,step:++step})
  const observed=tool('cu_browser_observe',{}, {ok:true,url:'http://127.0.0.1/tab-detail',accessibility_tree:'核对码 ABC123'})
  if(!original)original=observed
  if(i%10===0&&i<30)add('compaction/prune',{shadowedSeqs:[observed.seq]})
 }
 tool('cu_browser_recall',{event_seq:original.seq},{ok:true,source_event_seq:original.seq,content_text:'核对码 ABC123'})
 tool('cu_browser_click',{}, {ok:true})
 add('user/message',{source:{kind:'computer-use-state'},content:[{type:'text',text:JSON.stringify({summary:{first_error:{text:'ORIGIN_DENIED'},decisions:[{id:3}],current_stage:{text:'准备保存一次'}}})}]},{surfaceOp:'append'})
 const input={events,server:{submissions:1,last:{title:'ABC123',description:'长流程验收'}},answer:'ABC123 ORIGIN_DENIED 最终方案',code:'ABC123',exitCode:0,timedOut:false}
 const result=evaluateLongContext(input);assert.equal(result.success,true);assert.equal(result.retention_steps,3)
 const tampered=structuredClone(events),imageEvent=tampered.find(e=>e.type==='tool/result'&&e.data.message.content?.some(b=>b.attachment?.attachmentId==='sha256:second')&&e.data.message.content.some(b=>b.text?.includes('source_event_seq')))
 imageEvent.data.message.content=imageEvent.data.message.content.map(b=>b.type==='image'?{...b,attachment:{...b.attachment,attachmentId:'sha256:other'}}:b)
 const rejected=evaluateLongContext({...input,events:tampered});assert.equal(rejected.success,false);assert.equal(rejected.checks.offloaded_image_reissued,false)
 const pinnedRemoved=[...events,{seq:seq+1,type:'image/offload',data:{targets:[{seq:pinned.seq,imageIndexes:[0]}]}}]
 assert.equal(evaluateLongContext({...input,events:pinnedRemoved}).checks.pinned_screenshot_preserved,false)
 const offloadLate=events.filter(e=>e.type!=='image/offload').concat([{seq:seq+1,type:'image/offload',data:{targets:[{seq:oldImage.seq,imageIndexes:[0]}]}}])
 assert.equal(evaluateLongContext({...input,events:offloadLate}).checks.offloaded_image_reissued,false,'recall before offload cannot prove reissue after offload')
 const nativeRecall=events.find(e=>e.type==='tool/call'&&e.data.name==='cu_browser_image_recall').data.callId
 const ptcContent=[{type:'text',text:JSON.stringify({ok:true,source_event_seq:oldImage.seq,image_index:0})},image2]
 const ptcEvents=events.filter(e=>e.data?.callId!==nativeRecall&&e.data?.message?.toolCallId!==nativeRecall).concat([{seq:seq+1,type:'tool/ptc-dispatch',data:{rootCallId:'ptc-root',subCallId:'image-recall',name:'cu_browser_image_recall',content:ptcContent}}])
 assert.equal(evaluateLongContext({...input,events:ptcEvents}).checks.offloaded_image_reissued,false,'PTC dispatch alone is not model-visible')
 const delivered=[...ptcEvents,{seq:seq+2,type:'user/message',surfaceOp:'append',data:{source:{kind:'ptc-mode'},content:ptcContent}}]
 assert.equal(evaluateLongContext({...input,events:delivered}).checks.offloaded_image_reissued,true,'matching later PTC image delivery establishes reissue')
})
