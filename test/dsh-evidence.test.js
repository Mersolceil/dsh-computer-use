import test from 'node:test'
import assert from 'node:assert/strict'
import {dshImageEvidence} from '../eval/dsh-log.js'
const image=id=>({type:'image',attachment:{attachmentId:id}})
test('DSH image evidence distinguishes delivered Native and PTC attachments',()=>{
  const native={seq:1,type:'tool/result',surfaceOp:'append',data:{message:{content:[image('native')]}}}
  const dispatch={seq:2,type:'tool/ptc-dispatch',data:{content:[image('ptc')]}}
  const delivered={seq:3,type:'user/message',surfaceOp:'append',data:{source:{kind:'ptc-mode'},content:[image('ptc')]}}
  assert.equal(dshImageEvidence([native]).native_image_blocks,1)
  assert.equal(dshImageEvidence([dispatch]).delivered_image_blocks,0)
  assert.equal(dshImageEvidence([delivered]).delivered_image_blocks,0)
  assert.equal(dshImageEvidence([dispatch,delivered]).ptc_delivered_image_blocks,1)
  assert.equal(dshImageEvidence([{...dispatch,data:{...dispatch.data,isError:true}},delivered]).delivered_image_blocks,0)
  assert.equal(dshImageEvidence([dispatch,{...delivered,seq:1}]).delivered_image_blocks,0)
  assert.equal(dshImageEvidence([dispatch,{...delivered,data:{...delivered.data,source:{kind:'user'}}}]).delivered_image_blocks,0)
  assert.equal(dshImageEvidence([dispatch,delivered,{...delivered,seq:4}]).delivered_image_blocks,1)
  assert.equal(dshImageEvidence([{...native,data:{message:{isError:true,content:[image('native')]}}}]).delivered_image_blocks,0)
})
