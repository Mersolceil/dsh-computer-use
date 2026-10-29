import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyLedger,appendLedger} from '../src/ledger.js'
import {buildTaskState,publishTaskState,taskStateDefinition} from '../src/task-state.js'
function memory(){let ledger=emptyLedger();for(const e of [{kind:'goal',source:'user',text:'Save once'},{kind:'decision',source:'agent',text:'Old cause'},{kind:'error',source:'driver',text:'ORIGINAL',verified:true,evidence:[7]},{kind:'decision',source:'agent',text:'Withdraw old cause',supersedes:2},{kind:'stage',source:'agent',text:'Inspect result'}])ledger=appendLedger(ledger,e);return{ledger,limited:false}}
test('incremental state preserves original error and corrected decision without promoting claims',()=>{const m=memory();const prior=buildTaskState({...m,ledger:{revision:3,entries:m.ledger.entries.slice(0,3)}});const full=buildTaskState(m,prior.rollup);assert.deepEqual(full,buildTaskState(m));assert.equal(full.summary.first_error.text,'ORIGINAL');assert.deepEqual(full.summary.decisions.map(e=>e.id),[4]);assert.equal(full.summary.current_stage.verification_scope,'unverified_claim');assert.deepEqual(buildTaskState(m,full.rollup),full)})
test('snapshot budget stays bounded while full excerpts remain available in the ledger',()=>{let ledger=emptyLedger();for(let i=0;i<100;i++)ledger=appendLedger(ledger,{kind:'decision',source:'agent',text:'x'.repeat(2000),evidence:[]});const r=buildTaskState({ledger,limited:false});assert.equal(r.summary.decisions.length,8);assert.equal(r.summary.decisions_omitted,92);assert.ok(JSON.stringify(r.summary).length<8000);assert.equal(ledger.entries[0].text.length,2000)})
test('failed publication does not advance the anchor; successful retry is idempotent',()=>{const d=taskStateDefinition();let state=d.init();const session={surface:{nodes:[]},append(){throw Error('write failed')}};assert.throws(()=>publishTaskState(session,memory(),state,{estimateMessage:()=>1}));assert.equal(state.rollup.anchor,0);session.append=(type,data,opts)=>{const e={seq:2,type,data,...opts};state=d.apply(state,e);session.surface.nodes=[2];return e};assert.equal(publishTaskState(session,memory(),state,{estimateMessage:()=>1}),true);assert.equal(state.rollup.anchor,5);assert.equal(publishTaskState(session,memory(),state,{estimateMessage:()=>1}),false)})
test('compaction blocks publication and shadowed snapshots reappear without resurrecting decisions',()=>{const d=taskStateDefinition();let state=d.init();const session={surface:{nodes:[]},append(type,data,opts){const e={seq:1,type,data,...opts};state=d.apply(state,e);return e}};assert.equal(publishTaskState(session,memory(),{...state,busy:true},{estimateMessage:()=>1}),false);publishTaskState(session,memory(),state,{estimateMessage:()=>1});session.surface.nodes=[];assert.equal(publishTaskState(session,memory(),state,{estimateMessage:()=>1}),true);assert.deepEqual(state.rollup.decisions,[4])})
test('full payload budget includes rollup and JSON escaping',()=>{let ledger=emptyLedger();for(let i=0;i<240;i++)ledger=appendLedger(ledger,{kind:'decision',source:'agent',text:'a'+String.fromCharCode(1).repeat(1000)});const state=buildTaskState({ledger,limited:false});assert.ok(Array.from(JSON.stringify(state)).length<=8000);assert.equal(state.summary.decisions_omitted,232);assert.ok(state.summary.decisions.every(e=>e.text_truncated));assert.equal(state.rollup.decisions.length,240)})
test('gaps cannot be hidden by a later ledger entry',()=>{const m=memory();m.ledger.entries=m.ledger.entries.filter(e=>e.id!==3);assert.throws(()=>buildTaskState(m),/gap/)} )
test('unrelated prune event without sequence list is safe',()=>{const d=taskStateDefinition(),state=d.init();assert.deepEqual(d.apply(state,{type:'compaction/prune',data:{}}),state)})
test('recent user constraints retain provenance, expose omissions and rebuild old checkpoints',()=>{
 let ledger=emptyLedger()
 for(let i=1;i<=9;i++)ledger=appendLedger(ledger,{kind:'goal',source:'user',text:`request ${i}`,evidence:[i+10]})
 const m={ledger,limited:false},state=buildTaskState(m)
 assert.equal(state.summary.user_intent.first.id,1)
 assert.deepEqual(state.summary.user_intent.recent.map(e=>e.id),[5,6,7,8,9])
 assert.equal(state.summary.user_intent.omitted,3)
 assert.ok(state.summary.user_intent.recent.every(e=>e.source==='user'&&e.verification_scope==='user_request'))
 assert.deepEqual(state.summary.user_intent.recent[0].evidence,[15])
 const prior=buildTaskState({...m,ledger:{revision:6,entries:ledger.entries.slice(0,6)}}).rollup
 delete prior.user_requests
 assert.deepEqual(buildTaskState(m,prior),state)
})
test('many heavily escaped user requests and decisions still fit the full snapshot budget',()=>{
 let ledger=emptyLedger()
 for(let i=0;i<256;i++)ledger=appendLedger(ledger,{kind:i%2?'decision':'goal',source:i%2?'agent':'user',text:'a'+String.fromCharCode(1).repeat(1000)})
 const snapshot=buildTaskState({ledger,limited:false})
 assert.ok(Array.from(JSON.stringify(snapshot)).length<=8000)
 assert.equal(snapshot.summary.user_intent.omitted,122)
 assert.equal(snapshot.summary.decisions_omitted,120)
 assert.ok(snapshot.summary.user_intent.recent.every(e=>e.text_truncated))
})
test('retry after prune succeeds without charging the same snapshot twice',()=>{
 const d=taskStateDefinition();let state=d.init(),seq=0,failReplace=false,prunes=0
 const session={surface:{nodes:[]},append(type,data,opts={}){
  if(type==='user/message'&&failReplace){failReplace=false;throw Error('replace failed')}
  if(type==='compaction/prune')prunes++
  const event={seq:++seq,type,data,...opts};state=d.apply(state,event)
  if(type==='user/message')this.surface.nodes=[seq]
 }}
 const meter={estimateMessage:()=>10},first=memory();publishTaskState(session,first,state,meter)
 const next={...first,ledger:appendLedger(first.ledger,{kind:'stage',source:'agent',text:'Continue'})}
 failReplace=true;assert.throws(()=>publishTaskState(session,next,state,meter),/replace failed/)
 assert.equal(state.rollup.anchor,5);assert.equal(state.priced,true);assert.equal(prunes,1)
 assert.equal(publishTaskState(session,next,state,meter),true);assert.equal(state.rollup.anchor,6);assert.equal(prunes,1)
})
