import test from 'node:test'
import assert from 'node:assert/strict'
import {compactPtcResult} from '../src/ptc-history.js'
import {modelObservation} from '../src/accessibility.js'
import {renderResult} from '../src/plugin.js'

const root={ok:true,observation_id:'obs',accessibility_tree:'- button: Save',elements:[{ref:'e1'}],text:'user data',history:{can_back:true},image_attachment:{attachmentId:'img'}}
const dispatch={seq:3,name:'cu_browser_observe',isError:false,content:[{type:'text',text:JSON.stringify(modelObservation({...root,image_attachment:undefined}))}]}
test('single matched observation drops only the tree and preserves all other output',()=>{
 const compact=compactPtcResult(JSON.stringify(root),[dispatch])
 assert.ok(compact);assert.equal(compact.accessibility_tree,undefined);assert.deepEqual(compact.elements,root.elements);assert.equal(compact.text,root.text);assert.deepEqual(compact.history,root.history);assert.deepEqual(compact.image_attachment,root.image_attachment);assert.equal(compact.computer_use_history.dispatch_event_seq,3)
})
test('mixed calls, altered values, failures and unparseable output remain untouched',()=>{
 const cases=[['not JSON',[dispatch]],[JSON.stringify(root),[]],[JSON.stringify(root),[dispatch,dispatch]],[JSON.stringify({...root,observation_id:'other'}),[dispatch]],[JSON.stringify({...root,ok:false}),[dispatch]],[JSON.stringify({...root,uncertain:true}),[dispatch]],[JSON.stringify(root),[{...dispatch,isError:true}]],[JSON.stringify(root),[{...dispatch,name:'cu_browser_memory'}]]]
 for(const [text,calls] of cases)assert.equal(compactPtcResult(text,calls),null)
})
test('unverified extra fields never get removed, even if guest code changed them',()=>{
 const changed={...root,elements:[{ref:'custom',value:'keep'}],text:'additional guest note'}
 const compact=compactPtcResult(JSON.stringify(changed),[dispatch])
 assert.deepEqual(compact.elements,changed.elements);assert.equal(compact.text,changed.text)
})
test('only host-witnessed identical duplicate text and elements may be omitted',()=>{
 const content=renderResult({},root,{duplicateWitness:true}),witnessed={...dispatch,content}
 const safe=compactPtcResult(JSON.stringify(root),[witnessed],{compactDuplicates:true})
 assert.equal(safe.elements,undefined);assert.equal(safe.text,undefined);assert.deepEqual(safe.computer_use_history.omitted,['accessibility_tree','elements','text'])
 const changed={...root,elements:[{ref:'changed'}],text:'program-added data'}
 const retained=compactPtcResult(JSON.stringify(changed),[witnessed],{compactDuplicates:true})
 assert.deepEqual(retained.elements,changed.elements);assert.equal(retained.text,changed.text)
 const old=compactPtcResult(JSON.stringify(root),[dispatch],{compactDuplicates:true});assert.deepEqual(old.elements,root.elements);assert.equal(old.text,root.text)
})
