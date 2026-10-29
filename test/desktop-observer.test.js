import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesktopObserver } from '../src/desktop-observer.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const valid = {ok:true,pid:12,bundle_id:'org.example.Lab',role:'AXApplication',windows:[],nodes:0,truncated:false,timed_out:false,values_read:false}
test('desktop observer requires an explicit allowlisted application and exact process identity',async()=>{
 let calls=0
 const observer=createDesktopObserver({helperPath:'/tmp/observe',allowedBundleIds:['org.example.Lab'],execute:async(path,args,options)=>{calls++;assert.equal(path,'/tmp/observe');assert.deepEqual(args,['12','org.example.Lab']);assert.equal(options.timeout,8000);return JSON.stringify(valid)}})
 assert.deepEqual(await observer.observe({pid:12,bundleId:'org.example.Other'}),{ok:false,error:'APPLICATION_NOT_ALLOWED'})
 assert.equal(calls,0);assert.deepEqual(await observer.observe({pid:12,bundleId:'org.example.Lab'}),valid);assert.equal(calls,1)
 await assert.rejects(observer.observe({pid:0,bundleId:'org.example.Lab'}),/target/)
})
test('malformed, oversize, spoofed and mismatched helper responses fail closed',async()=>{
 for(const value of ['not JSON','x'.repeat(512*1024+1),JSON.stringify({...valid,pid:13}),JSON.stringify({...valid,values_read:true}),JSON.stringify({...valid,nodes:201}),JSON.stringify({...valid,bundle_id:'org.example.Other'})]){
  const observer=createDesktopObserver({helperPath:'/tmp/observe',allowedBundleIds:['org.example.Lab'],execute:async()=>value})
  assert.deepEqual(await observer.observe({pid:12,bundleId:'org.example.Lab'}),{ok:false,error:'INVALID_HELPER_OUTPUT'})
 }
})
test('desktop trees reject undeclared fields, inconsistent counts and excessive nesting',async()=>{
 const tree={role:'AXWindow',title:'Fixture',children:[{role:'AXButton',description:'Open'}]}
 const variants=[
  {...valid,windows:[{...tree,value:'secret'}],nodes:2},
  {...valid,windows:[tree],nodes:1},
  {...valid,windows:[tree],nodes:2,extra:'secret'},
  {...valid,windows:[{role:'AXWindow',title:'x'.repeat(4097)}],nodes:1},
  {...valid,timed_out:true,truncated:false},
 ]
 let deep={role:'AXButton'};for(let i=0;i<9;i++)deep={role:'AXGroup',children:[deep]}
 variants.push({...valid,windows:[deep],nodes:10})
 const observer=value=>createDesktopObserver({helperPath:'/tmp/observe',allowedBundleIds:['org.example.Lab'],execute:async()=>JSON.stringify(value)})
 assert.deepEqual(await observer({...valid,windows:[tree],nodes:2}).observe({pid:12,bundleId:'org.example.Lab'}),{...valid,windows:[tree],nodes:2})
 for(const value of variants)assert.deepEqual(await observer(value).observe({pid:12,bundleId:'org.example.Lab'}),{ok:false,error:'INVALID_HELPER_OUTPUT'})
})
test('permission errors are explicit; subprocess errors do not leak output; abort propagates',async()=>{
 let execute=async()=>JSON.stringify({ok:false,error:'ACCESSIBILITY_PERMISSION_REQUIRED'})
 const observer=createDesktopObserver({helperPath:'/tmp/observe',allowedBundleIds:['org.example.Lab'],execute:(...args)=>execute(...args)})
 assert.equal((await observer.observe({pid:12,bundleId:'org.example.Lab'})).error,'ACCESSIBILITY_PERMISSION_REQUIRED')
 execute=async()=>{throw Error('sensitive output')};assert.deepEqual(await observer.observe({pid:12,bundleId:'org.example.Lab'}),{ok:false,error:'DESKTOP_HELPER_FAILED'})
 const abort=new AbortController();abort.abort();await assert.rejects(observer.observe({pid:12,bundleId:'org.example.Lab'},{signal:abort.signal}),{name:'AbortError'})
})
test('actual subprocess cannot report success after exiting with failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-cu-helper-test-'))
 try {
  const helper=join(dir,'helper')
  await writeFile(helper,`#!/bin/sh\nprintf '%s\n' '${JSON.stringify(valid)}'\nexit 1\n`,{mode:0o700})
  const observer=createDesktopObserver({helperPath:helper,allowedBundleIds:['org.example.Lab']})
  assert.deepEqual(await observer.observe({pid:12,bundleId:'org.example.Lab'}),{ok:false,error:'DESKTOP_HELPER_FAILED'})
  await writeFile(helper,`#!/bin/sh\nprintf '%s\n' '{"ok":false,"error":"ACCESSIBILITY_PERMISSION_REQUIRED"}'\nexit 3\n`,{mode:0o700})
  assert.deepEqual(await observer.observe({pid:12,bundleId:'org.example.Lab'}),{ok:false,error:'ACCESSIBILITY_PERMISSION_REQUIRED'})
 } finally { await rm(dir,{recursive:true,force:true}) }
})
