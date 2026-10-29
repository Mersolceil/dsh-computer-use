import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyLedger,appendLedger,ledgerView} from '../src/ledger.js'
test('decision corrections retain the old judgment but expose only the latest as active',()=>{
 const a=appendLedger(emptyLedger(),{kind:'decision',text:'createRequire is the only cause',source:'agent'})
 const b=appendLedger(a,{kind:'decision',text:'sole cause withdrawn; restart recovery observed',source:'agent',supersedes:1,evidence:[42]})
 assert.equal(a.entries.length,1);assert.equal(b.entries.length,2);assert.equal(ledgerView(b).active[0].id,2);assert.equal(ledgerView(b).superseded[0].id,1)
 assert.throws(()=>appendLedger(b,{kind:'decision',text:'stale correction',source:'agent',supersedes:1}))
})
test('model and page claims cannot claim verified completion',()=>{
 for(const source of ['agent','observation','user'])assert.throws(()=>appendLedger(emptyLedger(),{kind:'result',text:'done',source,verified:true,evidence:[1]}))
 assert.throws(()=>appendLedger(emptyLedger(),{kind:'result',text:'done',source:'driver',verified:true}))
 const s=appendLedger(emptyLedger(),{kind:'result',text:'tool executed; not business completion',source:'driver',verified:true,evidence:[7]});assert.equal(s.entries[0].verified,true)
})
test('original errors and uncertainty remain distinct across later progress',()=>{
 let s=appendLedger(emptyLedger(),{kind:'error',text:'original error',source:'driver',evidence:[1]})
 s=appendLedger(s,{kind:'uncertain',text:'submission not confirmed',source:'driver',evidence:[2]})
 s=appendLedger(s,{kind:'stage',text:'inspect result next',source:'agent'})
 assert.equal(ledgerView(s).active.length,3);assert.equal(s.entries[1].verified,false)
})
