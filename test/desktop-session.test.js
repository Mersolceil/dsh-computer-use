import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DesktopSession} from '../src/desktop-session.js'
async function fixture(run,node={role:'AXTextField',ref:'g1:field',actions:['fill']}){
 const dir=await mkdtemp(join(tmpdir(),'desktop-session-')),helper=join(dir,'helper')
 await writeFile(helper,`#!${process.execPath}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');send({ok:true,ready:true,pid:12,bundle_id:'org.dsh.fixture'});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.action==='observe')send({id:r.id,ok:true,pid:12,bundle_id:'org.dsh.fixture',editable_values_read:false,static_text_values_read:true,nodes:1,truncated:false,windows:[${JSON.stringify(node)}]});else if(r.text==='wait'){}else send({id:r.id,ok:true,requires_observation:true});});`,{mode:0o700})
 const session=new DesktopSession({helperPath:helper,allowedBundleIds:['org.dsh.fixture'],timeoutMs:2000})
 try{await run(session)}finally{await session.close();await rm(dir,{recursive:true,force:true})}
}
test('desktop session blocks other apps and invalidates refs after each action',()=>fixture(async session=>{
 assert.equal((await session.attach({pid:12,bundleId:'org.dsh.other'})).error_code,'APPLICATION_NOT_ALLOWED')
 assert.equal((await session.attach({pid:12,bundleId:'org.dsh.fixture'})).ok,true)
 assert.equal((await session.run('click',{target:'g1:field'})).error_code,'STALE_OR_UNSUPPORTED_REF')
 assert.equal((await session.run('fill',{target:'g1:field',text:'hello'})).ok,true)
 assert.equal((await session.run('fill',{target:'g1:field',text:'again'})).error_code,'STALE_OR_UNSUPPORTED_REF')
}))
test('timeout terminates helper and marks possible side effects uncertain',()=>fixture(async session=>{
 await session.attach({pid:12,bundleId:'org.dsh.fixture'})
 session.timeoutMs=50
 const result=await session.run('fill',{target:'g1:field',text:'wait'})
 assert.equal(result.error_code,'DESKTOP_HELPER_TIMEOUT');assert.equal(result.state_uncertain,true)
 assert.equal((await session.run('observe')).error_code,'NO_DESKTOP_SESSION')
}))
test('cancellation propagates and cleans up an active desktop request',()=>fixture(async session=>{
 await session.attach({pid:12,bundleId:'org.dsh.fixture'})
 const controller=new AbortController()
 const pending=session.run('fill',{target:'g1:field',text:'wait'},{signal:controller.signal})
 controller.abort()
 await assert.rejects(pending,{name:'AbortError'})
 assert.equal(session.child,null)
}))
test('changed process is rejected after the handshake before any AX observation',()=>fixture(async session=>{
 const result=await session.attach({pid:12,bundleId:'org.dsh.fixture',processStart:'1:2'},{verifyTarget:async()=>false})
 assert.equal(result.error_code,'TARGET_CHANGED');assert.equal(session.refs.size,0);assert.equal(session.child,null)
}))
test('static status text is visible while editable and protected values are rejected',async()=>{
 await fixture(async session=>{const result=await session.attach({pid:12,bundleId:'org.dsh.fixture'});assert.equal(result.windows[0].text,'Saved: 1')},{role:'AXStaticText',text:'Saved: 1'})
 for(const node of [{role:'AXTextField',text:'private'},{role:'AXTextField',protected:true,description:'private'}])await fixture(async session=>{assert.equal((await session.attach({pid:12,bundleId:'org.dsh.fixture'})).error_code,'INVALID_HELPER_OUTPUT')},node)
})
