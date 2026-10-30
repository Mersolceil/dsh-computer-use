import test from 'node:test'
import assert from 'node:assert/strict'
import {DesktopImageCache,desktopImagesDefinition,trimDesktopImages} from '../src/desktop-images.js'
test('image reuse requires exact bytes, app identity and an actually committed, nonoffloaded image',()=>{
 const cache=new DesktopImageCache(),ref={attachmentId:'sha256:image'},app={pid:1,process_start:'1:2',fingerprint:'file'},messages=[],agent={session:{deriveMessages:()=>messages}},bytes=Buffer.from('pixels')
 cache.remember(app,agent,bytes,ref);assert.equal(cache.find(app,agent,bytes),null)
 messages.push({id:'committed',role:'tool',source:{kind:'tool'},content:[{type:'image',attachment:ref}]});assert.equal(cache.find(app,agent,bytes).message_id,'committed')
 assert.equal(cache.find(app,agent,Buffer.from('different')),null);assert.equal(cache.find({...app,process_start:'9:9'},agent,bytes),null);messages[0].content[0].offloaded=true;assert.equal(cache.find(app,agent,bytes),null)
})
test('desktop image batches affect only attributable native results and preserve two recent images',async()=>{
 const def=desktopImagesDefinition();let state=def.init();const messages=[],nodes=[],events=[]
 for(let i=0;i<7;i++){const callId='c'+i;state=def.apply(state,{type:'tool/call',data:{callId,name:'cu_desktop_step'}});const message={id:'m'+i,role:'tool',toolCallId:callId,source:{kind:'tool',callId},content:[{type:'text',text:'{"ok":true}'},{type:'image',attachment:{attachmentId:'sha256:'+i}}]},e={type:'tool/result',seq:i+1,surfaceOp:'append',data:{message}};state=def.apply(state,e);messages.push(message);nodes.push(e.seq)}
 messages.push({id:'user-image',role:'user',content:[{type:'image',attachment:{attachmentId:'personal'}}]})
 const session={surface:{nodes},deriveMessages:()=>messages,append:(type,data)=>events.push({type,data})},store={readImage:async()=>{}}
 assert.equal((await trimDesktopImages(session,{...state,rows:state.rows.slice(0,6)},store)).offloaded,0)
 const result=await trimDesktopImages(session,state,store);assert.equal(result.offloaded,5);assert.deepEqual(events[0].data.targets.map(x=>x.seq),[1,2,3,4,5])
 assert.equal(state.rows.length,7);assert.equal(def.apply(state,{type:'tool/result',seq:99,surfaceOp:'append',data:{message:messages[7]}}),state)
 messages[0].content[0].text='{"ok":false}';messages.push({...messages[1]});assert.equal((await trimDesktopImages(session,state,store)).offloaded,0)
 session.append=()=>{throw Error('requires a message projection')};messages.pop();messages[0].content[0].text='{"ok":true}';assert.equal((await trimDesktopImages(session,state,store)).status,'host_projection_unavailable')
})
