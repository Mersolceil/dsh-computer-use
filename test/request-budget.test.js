import test from 'node:test'
import assert from 'node:assert/strict'
import {budgetSnapshot} from '../src/request-budget.js'

const base={measurement:{totalTokens:700,baseline:{kind:'estimated'}},pressure:{contextWindow:1000},header:{config:{provider:'p',model:'m'}},contextRoute:{provider:'p',model:'m'},imageCount:0,imagePricingKnown:false,reserveTokens:100}
test('budget status is an explicitly estimated committed-surface view',()=>{
 const r=budgetSnapshot(base);assert.equal(r.estimated_utilization,0.8);assert.equal(r.estimate_band,'high');assert.ok(r.warnings.some(x=>x.includes('pending user input')));assert.equal(r.baseline_kind,'estimated')
 assert.equal(budgetSnapshot({...base,reserveTokens:undefined}).estimate_band,'unknown')
 assert.equal(budgetSnapshot({...base,measurement:{totalTokens:400,baseline:{kind:'usage'}}}).estimate_band,'low')
})
test('missing or stale capacity and unpriced images never produce reassuring ratios',()=>{
 for(const change of [{pressure:{}},{contextRoute:{provider:'other',model:'m'}},{header:undefined},{imageCount:1,imagePricingKnown:false}]){
  const r=budgetSnapshot({...base,...change});assert.equal(r.estimated_utilization,null);assert.equal(r.estimate_band,'unknown')
 }
 assert.equal(budgetSnapshot({...base,imageCount:1,imagePricingKnown:true}).image_pricing,'route_available')
})
test('malformed host measurements and reserves fail closed',()=>{
 for(const change of [{measurement:{totalTokens:-1}},{reserveTokens:-1},{reserveTokens:10000001},{imageCount:-1}])assert.throws(()=>budgetSnapshot({...base,...change}))
})
