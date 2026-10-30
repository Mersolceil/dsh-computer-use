import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DesktopApprovalPanel} from '../src/desktop-approval.js'
test('floating approval transport rejects mismatched IDs and discards late replies after cancellation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-approval-test-')),helper=join(dir,'synthetic-helper')
 await writeFile(helper,`#!${process.execPath}\nprocess.stdin.once('data',raw=>{const r=JSON.parse(raw);if(r.reason==='late')setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,outcome:'allowed-once'})+'\\n'),1000);else process.stdout.write(JSON.stringify({id:'wrong',outcome:'allowed-once'})+'\\n')})\n`);await chmod(helper,0o700)
 const panel=new DesktopApprovalPanel(helper)
 try{assert.equal(await panel.request('wrong-id'),'unavailable');const abort=new AbortController(),pending=panel.request('late',{signal:abort.signal});abort.abort();assert.equal(await pending,'cancelled');assert.equal(panel.pending,undefined)}finally{panel.close();await rm(dir,{recursive:true,force:true})}
})
