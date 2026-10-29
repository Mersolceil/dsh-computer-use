import test from 'node:test'
import assert from 'node:assert/strict'
import {selectImageTargets,applyImageWindow} from '../src/image-window.js'

function fixture(){
 const rows=[],messages=[],nodes=[]
 for(let i=0;i<5;i++){
  const image={type:'image',attachment:{attachmentId:'sha256:'+i,mediaType:'image/png'}},message={id:'m'+i,role:'tool',toolCallId:'c'+i,source:{kind:'tool',callId:'c'+i},content:[{type:'text',text:'{"ok":true}'},image]}
  rows.push({seq:i+1,name:'cu_browser_screenshot',data:{message}});messages.push(message);nodes.push(i+1)
 }
 const events=[],session={surface:{nodes},deriveMessages:()=>messages,append(type,data){events.push({type,data})}}
 return {history:{rows,busy:false},pins:{pinned:[1],limited:false},session,events,messages}
}
test('window retains pinned and two recent screenshots while ignoring unrelated user images',()=>{
 const f=fixture();f.messages.unshift({id:'user',role:'user',source:{kind:'user'},content:[{type:'image',attachment:{attachmentId:'sha256:user'}}]})
 assert.deepEqual(selectImageTargets(f.session,f.history,f.pins,2).map(x=>x.seq),[2,3])
})
test('unknown pins, duplicate message IDs and changed attachments fail closed',()=>{
 const f=fixture();assert.deepEqual(selectImageTargets(f.session,f.history,{pinned:[999],limited:false},2),[])
 f.messages.push({...f.messages[1]});assert.deepEqual(selectImageTargets(f.session,f.history,f.pins,2).map(x=>x.seq),[3])
 f.messages[2]={...f.messages[2],content:[{type:'image',attachment:{attachmentId:'different'}}]};assert.deepEqual(selectImageTargets(f.session,f.history,f.pins,2),[])
})
test('uncertain screenshots and changed message identity are never offloaded',()=>{
 const f=fixture();f.history.rows[1].data.message.content[0].text='{"ok":true,"state_uncertain":true}'
 f.messages[2]={...f.messages[2],source:{kind:'user'}}
 assert.deepEqual(selectImageTargets(f.session,f.history,f.pins,2),[])
})
test('offload verifies attachments, uses host projection, and is safe when unavailable',async()=>{
 const f=fixture(),read=[];const store={async readImage(ref){read.push(ref.attachmentId)}}
 const result=await applyImageWindow(f.session,f.history,f.pins,store,{keep:2});assert.deepEqual(result,{status:'offloaded',offloaded:2})
 assert.deepEqual(read,['sha256:1','sha256:2']);assert.deepEqual(f.events[0],{type:'image/offload',data:{targets:[{seq:2,imageIndexes:[0]},{seq:3,imageIndexes:[0]}]}})
 f.session.append=()=>{throw Error('session event "image/offload" requires a message projection')}
 assert.equal((await applyImageWindow(f.session,f.history,f.pins,store,{keep:2})).status,'host_projection_unavailable')
 assert.equal((await applyImageWindow(f.session,f.history,f.pins,{readImage:async()=>{throw Error('missing')}},{keep:2})).status,'attachment_unavailable')
 assert.equal((await applyImageWindow(f.session,f.history,{pinned:[999],limited:false},store,{keep:2})).status,'pinned_evidence_unavailable')
 assert.equal((await applyImageWindow(f.session,f.history,{pinned:[],limited:true},store,{keep:2})).status,'pin_tracking_limited')
 const abort=new AbortController();abort.abort();await assert.rejects(applyImageWindow(f.session,f.history,f.pins,store,{signal:abort.signal}),{name:'AbortError'})
})
