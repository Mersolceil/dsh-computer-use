import test from 'node:test'
import assert from 'node:assert/strict'
import { historyDefinition, reduceHistory, recallHistory, recallImage, renderRecalledImage, compactObservation } from '../src/history.js'
function fixture(n=50) {
 const def=historyDefinition();let state=def.init();const messages=new Map(), events=[]
 const session={surface:{nodes:[]},deriveEventMessage:e=>e.data.message,append(type,data,opts){const e={seq:events.length,type,data,...opts};events.push(e);state=def.apply(state,e);if(type==='tool/result'){if(opts.surfaceOp.op==='replace')session.surface.nodes=session.surface.nodes.filter(s=>s!==opts.surfaceOp.startSeq);session.surface.nodes.push(e.seq);messages.set(e.seq,data.message)}return e}}
 for(let i=0;i<n;i++){
 session.append('tool/call',{name:'cu_browser_observe',callId:'c'+i},{})
 const value={ok:true,observation_id:'obs_'+i,active_tab_id:'t1',navigation_epoch:1,url:'https://example.org',accessibility_tree:'- status: record '+i+'\n'+'x'.repeat(12000),...(i===0?{ok:false,error_code:'FIRST_ERROR',message:'最初的错误',result_uncertain:true}:{})}
 session.append('tool/result',{turn:1,step:i+1,message:{role:'tool',toolCallId:'c'+i,source:{kind:'tool',callId:'c'+i},content:[{type:'text',text:JSON.stringify(value)}]}},{surfaceOp:'append'})
 }
 return {session,events,get state(){return state},messages}
}
const meter={estimateMessage:()=>100}
test('50 steps retain recent observations and uncertain error, with valid smaller JSON for older results',()=>{
 const f=fixture();const r=reduceHistory(f.session,f.state,meter,4);assert.equal(r.length,45)
 const text=f.session.surface.nodes.map(s=>f.messages.get(s).content[0].text)
 assert.equal(text.filter(s=>JSON.parse(s).accessibility_tree).length,5)
 assert.ok(text.some(s=>s.includes('最初的错误')))
 assert.ok(text.some(s=>JSON.parse(s).historical_status_excerpt==='- status: record 1'))
 for(const x of r){assert.ok(f.events.find(e=>e.seq===x.source));assert.deepEqual(f.events[x.replacement].sourceEventSeqs,[x.source])}
 assert.equal(reduceHistory(f.session,f.state,meter,4).length,0,'repeat reductions must be idempotent')
})
test('recall finds exact original in the same state after reduction, with bounded unicode paging',()=>{
 const f=fixture();reduceHistory(f.session,f.state,meter,4)
 const first=f.state.rows[1];const out=recallHistory(f.state,{event_seq:first.seq,max_chars:500})
 assert.equal(Array.from(out.content_text).length,500);assert.equal(out.next_offset,500)
 assert.equal(recallHistory(historyDefinition().init(),{event_seq:first.seq}).error_code,'HISTORY_NOT_FOUND')
 assert.throws(()=>recallHistory(f.state,{event_seq:first.seq,max_chars:999999}))
 assert.equal(first.data.message.content[0].text, f.events[first.seq].data.message.content[0].text)
})
test('unrelated tool outputs, PTC wrappers and replacements are not archived as new observations',()=>{
 const d=historyDefinition();let s=d.init();const e={type:'tool/result',seq:3,surfaceOp:'append',data:{message:{toolCallId:'other',content:[{type:'text',text:'{}'}]}}};assert.equal(d.apply(s,e),s)
 s=d.apply(s,{type:'tool/call',data:{callId:'other',name:'run_code'}});assert.equal(d.apply(s,e),s)
})
test('active host compaction suppresses retention; end releases it',()=>{
 const f=fixture();const d=historyDefinition();const busy=d.apply(f.state,{type:'compaction/start'});assert.equal(reduceHistory(f.session,busy,meter).length,0)
 assert.ok(reduceHistory(f.session,d.apply(busy,{type:'compaction/end'}),meter).length)
})
test('recording failure leaves the original observation available and fails before claiming success',()=>{
 const f=fixture();f.session.append=()=>{throw Error('disk failure')};const original=[...f.session.surface.nodes];assert.throws(()=>reduceHistory(f.session,f.state,meter),/disk failure/);assert.deepEqual(f.session.surface.nodes,original)
})
test('a replacement failure after a committed prune does not charge twice on retry',()=>{
 const f=fixture(7),row=f.state.rows[1],append=f.session.append.bind(f.session);let fail=true
 f.session.append=(type,data,opts)=>{
  if(fail&&type==='tool/result'&&opts?.surfaceOp?.op==='replace'){fail=false;throw Error('replace failed')}
  return append(type,data,opts)
 }
 assert.throws(()=>reduceHistory(f.session,f.state,meter,4),/replace failed/)
 assert.ok(f.session.surface.nodes.includes(row.seq),'the original remains live')
 assert.ok(f.state.priced.includes(row.seq),'the committed prune is retained')
 assert.equal(f.events.filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs.includes(row.seq)).length,1)
 const result=reduceHistory(f.session,f.state,meter,4)
 assert.ok(result.some(x=>x.source===row.seq))
 assert.equal(f.events.filter(e=>e.type==='compaction/prune'&&e.data.shadowedSeqs.includes(row.seq)).length,1)
 assert.ok(recallHistory(f.state,{event_seq:row.seq}).content_text.includes('record 1'))
})
test('legacy history checkpoints without priced rows remain valid',()=>{
 const d=historyDefinition(),s=d.init();delete s.priced
 assert.equal(d.stateSchema.parse(s),s)
 assert.doesNotThrow(()=>d.apply(s,{type:'compaction/prune',data:{shadowedSeqs:[999]}}))
 assert.throws(()=>d.stateSchema.parse({...s,priced:[-1]}),/checkpoint/)
})
test('images and file hashes are retained; page status is labelled historical rather than completed',()=>{
 const v={ok:true,accessibility_tree:'- alert: Saved',files_selected:[{sha256:'abc'}],image_attachment:{attachmentId:'img'}};const c=compactObservation(v);assert.deepEqual(c.files_selected,v.files_selected);assert.deepEqual(c.image_attachment,v.image_attachment);assert.equal(c.completed,undefined);assert.ok(c.omitted)
})

test('a successful-looking outcome still preserves a declared uncertain state',()=>{
 const f=fixture();const row=f.state.rows[1];const v=JSON.parse(row.data.message.content[0].text);v.state_uncertain=true;row.data.message.content[0].text=JSON.stringify(v);const changed=reduceHistory(f.session,f.state,meter,4);assert.ok(!changed.some(x=>x.source===row.seq))
})

test('compressing an early screenshot text never removes its image block',()=>{
 const f=fixture();const row=f.state.rows[1];const image={type:'image',attachment:{attachmentId:'sha256:retained',mediaType:'image/png',width:10,height:10}};row.data.message.content.push(image);const r=reduceHistory(f.session,f.state,meter,4).find(x=>x.source===row.seq);assert.ok(r);assert.deepEqual(f.messages.get(r.replacement).content[1],image)
})
test('opt-in PTC compacts only exactly matched single dispatch and can recall the root result',()=>{
 const d=historyDefinition({ptcEnabled:true});let state=d.init(),seq=0;const events=[],messages=new Map()
 const s={surface:{nodes:[]},deriveEventMessage:e=>e.data.message,append(type,data,opts={}){
  const e={seq:++seq,type,data,...opts};events.push(e);state=d.apply(state,e)
  if(type==='tool/result'){if(opts.surfaceOp?.op==='replace')this.surface.nodes=this.surface.nodes.filter(x=>x!==opts.surfaceOp.startSeq);this.surface.nodes.push(e.seq);messages.set(e.seq,data.message)}return e
 }}
 const root={ok:true,observation_id:'one',accessibility_tree:'- button: Save\n'+'x'.repeat(6000),elements:[{ref:'e1'}],text:'kept guest output',history:{can_back:true}}
 const observed={...root};delete observed.elements;delete observed.text
 const add=(id,alter=false,multiple=false)=>{
  s.append('tool/call',{name:'run_code',callId:id})
  s.append('tool/ptc-dispatch-start',{rootCallId:id,subCallId:id+':1',name:'cu_browser_observe'})
  if(multiple)s.append('tool/ptc-dispatch-start',{rootCallId:id,subCallId:id+':2',name:'other_tool'})
  s.append('tool/ptc-dispatch',{rootCallId:id,subCallId:id+':1',name:'cu_browser_observe',isError:false,content:[{type:'text',text:JSON.stringify(observed)}]})
  return s.append('tool/result',{message:{role:'tool',toolCallId:id,content:[{type:'text',text:JSON.stringify(alter?{...root,observation_id:'changed'}:root)}]}},{surfaceOp:'append'})
 }
 const first=add('root1'),altered=add('root2',true),mixed=add('root3',false,true);add('recent')
 assert.equal(state.rows.length,2);const reduced=reduceHistory(s,state,meter,1)
 assert.equal(reduced.length,1);assert.equal(reduced[0].source,first.seq)
 const compact=JSON.parse(messages.get(reduced[0].replacement).content[0].text)
 assert.equal(compact.accessibility_tree,undefined);assert.deepEqual(compact.elements,root.elements);assert.deepEqual(compact.history,root.history);assert.equal(compact.computer_use_history.source_event_seq,first.seq)
 assert.ok(recallHistory(state,{event_seq:first.seq,max_chars:16000}).content_text.includes('button: Save'))
 assert.ok(s.surface.nodes.includes(altered.seq)&&s.surface.nodes.includes(mixed.seq))
 assert.deepEqual(state.ptcRoots,{},'completed root data is discarded')
})
test('cancelled PTC turns discard pending data and late results fail closed',()=>{
 const d=historyDefinition({ptcEnabled:true});let state=d.init()
 state=d.apply(state,{type:'tool/call',data:{name:'run_code',callId:'root'}})
 state=d.apply(state,{type:'tool/ptc-dispatch-start',data:{rootCallId:'root',subCallId:'sub',name:'cu_browser_observe'}})
 state=d.apply(state,{type:'tool/ptc-dispatch',seq:2,data:{rootCallId:'root',subCallId:'sub',name:'cu_browser_observe',content:[{type:'text',text:'{"ok":true}'}]}})
 assert.ok(state.ptcRoots.root)
 state=d.apply(state,{type:'turn/end',data:{reason:{kind:'aborted'}}})
 assert.deepEqual(state.ptcRoots,{})
 state=d.apply(state,{type:'tool/result',seq:4,surfaceOp:'append',data:{message:{toolCallId:'root',content:[{type:'text',text:'{"ok":true}'}]}}})
 assert.equal(state.rows.length,0)
})
test('matched PTC image context loses only old tree text and retains the image with recall',()=>{
 const d=historyDefinition({ptcEnabled:true});let state=d.init(),seq=0;const messages=new Map()
 const s={surface:{nodes:[]},deriveEventMessage:e=>e.type==='user/message'?e.data:e.data.message,append(type,data,opts={}){
  const e={seq:++seq,type,data,...opts};state=d.apply(state,e)
  if(type==='user/message'||type==='tool/result'){if(opts.surfaceOp?.op==='replace')this.surface.nodes=this.surface.nodes.filter(x=>x!==opts.surfaceOp.startSeq);this.surface.nodes.push(e.seq);messages.set(e.seq,type==='user/message'?data:data.message)}return e
 }}
 const image={type:'image',attachment:{attachmentId:'sha256:fixture',mediaType:'image/png',width:10,height:10}}
 function add(i,alter=false){
  const id='r'+i,value={ok:true,observation_id:'o'+i,accessibility_tree:'- status: evidence '+i+'\n'+'x'.repeat(6000)}
  const content=[{type:'text',text:JSON.stringify(value)},image]
  s.append('tool/call',{name:'run_code',callId:id});s.append('tool/ptc-dispatch-start',{rootCallId:id,subCallId:id+':1'})
  s.append('tool/ptc-dispatch',{rootCallId:id,subCallId:id+':1',name:'cu_browser_screenshot',isError:false,content})
  return s.append('user/message',{id:'img'+i,role:'user',source:{kind:'ptc-mode'},content:alter?[...content,{type:'text',text:'additional'}]:content},{surfaceOp:'append'})
 }
 const first=add(0),changed=add(1,true);add(2);add(3)
 assert.equal(state.rows.length,3)
 const reduced=reduceHistory(s,state,meter,2);assert.equal(reduced.length,1);assert.equal(reduced[0].source,first.seq)
 const m=messages.get(reduced[0].replacement),v=JSON.parse(m.content[0].text)
 assert.deepEqual(m.content[1],image);assert.equal(v.accessibility_tree,undefined);assert.equal(v.computer_use_history.source_event_seq,first.seq)
 assert.ok(recallHistory(state,{event_seq:first.seq,max_chars:16000}).content_text.includes('evidence 0'))
 assert.ok(s.surface.nodes.includes(changed.seq),'nonmatching image message is not touched')
})
test('ambiguous identical screenshot deliveries are never rewritten',()=>{
 const d=historyDefinition({ptcEnabled:true});let state=d.init(),seq=0
 const apply=(type,data,extra={})=>{state=d.apply(state,{type,data,seq:++seq,...extra})}
 const value={ok:true,accessibility_tree:'- status: unchanged'},content=[{type:'text',text:JSON.stringify(value)},{type:'image',attachment:{attachmentId:'same'}}]
 for(const id of ['a','b']){apply('tool/call',{name:'run_code',callId:id});apply('tool/ptc-dispatch-start',{rootCallId:id,subCallId:id+':1'});apply('tool/ptc-dispatch',{rootCallId:id,subCallId:id+':1',name:'cu_browser_screenshot',isError:false,content})}
 apply('user/message',{role:'user',source:{kind:'ptc-mode'},content},{surfaceOp:'append'})
 assert.equal(state.rows.length,0);assert.equal(state.ptcImages.length,2)
})
test('image recall only reissues a screenshot attachment in the selected session',()=>{
 const image={type:'image',attachment:{attachmentId:'sha256:abc',mediaType:'image/png',width:10,height:10}}
 const state={rows:[{seq:2,name:'cu_browser_screenshot',mode:'ptc-image',data:{content:[{type:'text',text:'{}'},image]}},{seq:4,name:'cu_browser_observe',data:{message:{content:[image]}}}]}
 const value=recallImage(state,{event_seq:2});assert.equal(value.ok,true);assert.deepEqual(value.image_attachment,image.attachment)
 assert.deepEqual(renderRecalledImage({},value)[1],image)
 assert.equal(recallImage(state,{event_seq:4}).error_code,'IMAGE_HISTORY_NOT_FOUND')
 assert.equal(recallImage({rows:[]},{event_seq:2}).error_code,'IMAGE_HISTORY_NOT_FOUND')
 assert.equal(recallImage(state,{event_seq:2,image_index:1}).error_code,'IMAGE_HISTORY_NOT_FOUND')
 assert.throws(()=>recallImage(state,{event_seq:2,image_index:32}),/range/)
})
