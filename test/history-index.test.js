import test from 'node:test'
import assert from 'node:assert/strict'
import{historyIndex}from'../src/history.js'
test('history index issues bounded actual row IDs and distinguishes deferred images',()=>{
 const state={rows:[{seq:9,name:'cu_browser_observe',data:{message:{content:[{type:'text',text:'private page text'}]}}},{seq:21,name:'cu_browser_screenshot',mode:'ptc-image',data:{content:[{type:'image',attachment:{attachmentId:'image'}}]}}]}
 const first=historyIndex(state,{limit:1})
 assert.equal(first.entries[0].source_event_seq,9);assert.equal(first.next_after_seq,9)
 assert.ok(!JSON.stringify(first).includes('private page text'))
 const images=historyIndex(state,{action:'cu_browser_screenshot'})
 assert.deepEqual(images.entries,[{source_event_seq:21,action:'cu_browser_screenshot',mode:'ptc-image',image_count:1}])
 assert.equal(historyIndex(state,{after_seq:21}).entries.length,0)
 assert.throws(()=>historyIndex(state,{limit:51}))
 assert.throws(()=>historyIndex(state,{after_seq:-2}))
 assert.throws(()=>historyIndex(state,{action:'anything'}))
 assert.equal(historyIndex(undefined).error_code,'HISTORY_UNAVAILABLE')
})
