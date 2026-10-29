import test from 'node:test'
import assert from 'node:assert/strict'
import {imagePinsDefinition,validateImagePin} from '../src/image-pins.js'
const image={type:'image',attachment:{attachmentId:'sha256:fixture'}}
const history={rows:[{seq:7,name:'cu_browser_screenshot',data:{message:{content:[image]}}}]}
const outcome=(a)=>[{type:'text',text:JSON.stringify({accepted:true,...a})}]
test('pins require a recorded screenshot and have a bounded capacity',()=>{
 const d=imagePinsDefinition(),s=d.init()
 assert.equal(validateImagePin(s,history,{event_seq:7,pinned:true}).status,'pending_recording')
 assert.throws(()=>validateImagePin(s,history,{event_seq:8,pinned:true}),/recorded screenshot/)
 assert.throws(()=>validateImagePin(s,history,{event_seq:7,pinned:true,source:'user'}),/Expected/)
 assert.throws(()=>validateImagePin({...s,pinned:Array.from({length:64},(_,i)=>i+100)},history,{event_seq:7,pinned:true}),/limit/)
})
test('native and PTC pin decisions commit once only after accepted outcome',()=>{
 const d=imagePinsDefinition();let s=d.init()
 const apply=(type,data,extra={})=>{s=d.apply(s,{type,data,seq:10,...extra})}
 const a={event_seq:7,pinned:true}
 apply('tool/call',{name:'cu_browser_image_pin',callId:'n',arguments:JSON.stringify(a)})
 assert.deepEqual(s.pinned,[])
 const result={message:{toolCallId:'n',content:outcome(a)}}
 apply('tool/result',result,{surfaceOp:'append'});assert.deepEqual(s.pinned,[7]);assert.equal(s.receipts[0].status,'committed')
 apply('tool/result',result,{surfaceOp:'append'});assert.equal(s.receipts.length,1)
 const b={event_seq:7,pinned:false}
 apply('tool/ptc-dispatch-start',{name:'cu_browser_image_pin',subCallId:'p',arguments:b})
 apply('tool/ptc-dispatch',{subCallId:'p',content:outcome(b),isError:false});assert.deepEqual(s.pinned,[])
 apply('tool/call',{name:'cu_browser_image_pin',callId:'n',arguments:JSON.stringify(a)})
 apply('tool/result',result,{surfaceOp:'append'});assert.deepEqual(s.pinned,[],'completed call ID cannot be replayed')
})
test('failed, forged or mismatched responses cannot commit a pin',()=>{
 const d=imagePinsDefinition();let s=d.init(),a={event_seq:7,pinned:true}
 s=d.apply(s,{type:'tool/call',data:{name:'cu_browser_image_pin',callId:'n',arguments:JSON.stringify(a)}})
 s=d.apply(s,{type:'tool/result',seq:2,surfaceOp:'append',data:{message:{toolCallId:'n',isError:true,content:outcome(a)}}})
 assert.deepEqual(s.pinned,[]);assert.deepEqual(s.completed,['n'])
 s=d.apply(s,{type:'tool/result',seq:3,surfaceOp:'append',data:{message:{toolCallId:'n',content:outcome(a)}}})
 assert.deepEqual(s.pinned,[])
})
