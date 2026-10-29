import test from 'node:test'
import assert from 'node:assert/strict'
import {summarizeRequestUsage} from '../eval/request-usage.js'

test('peak request includes cache input without conflating task totals',()=>{
 const events=[{type:'status',phase:'step_end',usage:{inputTokens:100,cacheReadTokens:900,cacheWriteTokens:10,outputTokens:400}},{type:'status',phase:'step_end',usage:{inputTokens:200,cacheReadTokens:400,outputTokens:900}},{type:'status',phase:'other',usage:{inputTokens:9000}}]
 assert.deepEqual(summarizeRequestUsage(events),{request_usage_samples:2,peak_request_input_tokens:1010})
})
test('missing and malformed provider samples are reported as unavailable',()=>{
 assert.deepEqual(summarizeRequestUsage([]),{request_usage_samples:0,peak_request_input_tokens:null})
 assert.deepEqual(summarizeRequestUsage([{type:'status',phase:'step_end',usage:{inputTokens:10,cacheReadTokens:-1}}]),{request_usage_samples:0,peak_request_input_tokens:null})
})
