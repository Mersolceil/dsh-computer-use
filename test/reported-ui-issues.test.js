import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BrowserSession} from '../src/browser.js'
import {apply as browserPlugin} from '../src/plugin.js'
import {DesktopApplications} from '../src/desktop-apps.js'
import {apply as desktopPlugin,renderDesktopResult} from '../src/desktop-plugin.js'
import {startLab} from '../eval/lab.js'

function host(approval){const defs=new Map(),disposers=[];return {defs,disposers,ctx:{tools:{register:s=>{defs.set(s.name,s);return()=>defs.delete(s.name)}},on:(n,fn)=>{if(n==='dispose')disposers.push(fn)},get:()=>approval}}}
const signal=()=>new AbortController().signal

test('reported: opening an existing nonselected tab preserves state; missing AX cannot block a real browser screenshot',async t=>{
 const lab=await startLab({port:0}),dir=await mkdtemp(join(tmpdir(),'cu-report-')),s=new BrowserSession({allowedOrigins:[lab.origin],artifactDir:dir})
 t.after(async()=>{await s.shutdown();await lab.close();await rm(dir,{recursive:true,force:true})})
 const first=await s.run('open',{url:lab.origin+'/tabs'});assert.equal(first.ok,true,JSON.stringify(first))
 await s.page.evaluate(()=>{const p=document.createElement('p');p.textContent='Plain article body retained after switching';document.body.append(p);window.userUnsubmittedDraft='keep me';history.replaceState({},'', '/changed-spa-route')})
 const original=s.page
 assert.ok((await s.run('observe')).accessibility_tree.includes('Plain article body retained after switching'))
 await s.run('tab_new',{url:lab.origin+'/tab-detail'})
 const reused=await s.run('open',{url:lab.origin+'/tabs'});assert.equal(reused.ok,true,JSON.stringify(reused));assert.equal(reused.reused_tab,true);assert.equal(reused.active_tab_id,first.active_tab_id);assert.equal(reused.tabs.length,2);assert.equal(s.page,original);assert.equal(await s.page.evaluate(()=>window.userUnsubmittedDraft),'keep me')
 const read=s.ax.read;s.ax.read=async()=>{throw Object.assign(Error('synthetic AX failure'),{code:'AX_UNAVAILABLE'})}
 const picture=await s.run('screenshot');s.ax.read=read
 assert.equal(picture.ok,true,JSON.stringify(picture));assert.equal(picture.observation_available,false);assert.equal(picture.observation_error,'AX_UNAVAILABLE');assert.equal(picture.capture_source,'owned-browser-viewport');assert.equal(Buffer.from(picture.screenshot.data,'base64').subarray(1,4).toString(),'PNG')
})

test('reported: new origins require approval before admission; grants are exact and expire with the owned session',async()=>{
 const original=BrowserSession.prototype.run;let outcome='rejected',asks=0,executions=0
 BrowserSession.prototype.run=async function(action,args){executions++;if(action==='open')this.checkUrl(args.url);if(action==='close')this.stopped=true;return {ok:true}}
 const h=host({request:async request=>{asks++;assert.match(request.reason,/https:\/\/example.com/);return outcome}}),agent={session:{}},call=(action,args={})=>h.defs.get('cu_browser_'+action).execute(args,{agent,signal:signal(),callId:'local'})
 try{
  browserPlugin(h.ctx,{allowedOrigins:['http://127.0.0.1:4173']})
  assert.equal((await call('open',{url:'https://example.com/'})).error_code,'APPROVAL_REJECTED');assert.equal(executions,0)
  outcome='allowed-once';assert.equal((await call('open',{url:'https://example.com/'})).ok,true);await call('open',{url:'https://example.com/path'});assert.equal(asks,2)
  await assert.rejects(call('authorize_origins',{origins:['https://example.com/path']}),/exact HTTP/)
  await assert.rejects(call('open',{url:'https://example.com/',approved:true}),/Unknown argument/)
  await call('close');outcome='rejected';assert.equal((await call('open',{url:'https://example.com/'})).error_code,'APPROVAL_REJECTED');assert.equal(asks,3)
 }finally{for(const fn of h.disposers)await fn();BrowserSession.prototype.run=original}
})

test('reported: a real-window screenshot is independent of AX, requires fresh consent and is returned as an image attachment',async()=>{
 const originals=['inspect','windows','screenshot'].map(k=>DesktopApplications.prototype[k]),app={pid:42,bundle_id:'org.example.test',name:'Fixture',path:'/Applications/Fixture.app',fingerprint:'known',process_start:'123:4'}
 let outcome='rejected',captures=0,permission=false,images=0
 DesktopApplications.prototype.inspect=async()=>({ok:true,application:app})
 DesktopApplications.prototype.windows=async()=>({ok:true,windows:[{window_id:17,on_screen:true},{window_id:18,on_screen:false}]})
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==','base64')
 DesktopApplications.prototype.screenshot=async()=>{captures++;return permission?{ok:true,capture_source:'macos-window',window_id:17,screenshot:{data:png.toString('base64'),mimeType:'image/png',width:1,height:1}}:{ok:false,error_code:'SCREEN_RECORDING_PERMISSION_REQUIRED'}}
 const h=host({request:async()=>outcome});h.ctx.attachments={saveImages:async values=>{images++;assert.deepEqual(values[0].data,png);return [{attachmentId:'sha256:fixture',mediaType:'image/png',width:1,height:1,bytes:png.length}]}}
 const agent={session:{}},call=args=>h.defs.get('cu_desktop_screenshot').execute({pid:42,bundleId:app.bundle_id,...args},{agent,signal:signal(),callId:'capture'})
 try{
  desktopPlugin(h.ctx,{helperPath:'/helper'})
  assert.equal((await call({window_id:999})).error_code,'UNKNOWN_WINDOW');assert.equal(captures,0)
  assert.equal((await call({window_id:18})).error_code,'WINDOW_NOT_ON_SCREEN');assert.equal(captures,0)
  assert.equal((await call({window_id:17})).error_code,'APPROVAL_REJECTED');assert.equal(captures,0)
  outcome='allowed-once';assert.equal((await call({window_id:17})).error_code,'SCREEN_RECORDING_PERMISSION_REQUIRED');assert.equal(images,0)
  permission=true;const value=await call({window_id:17});assert.equal(value.capture_source,'macos-window');assert.equal(value.screenshot,undefined);assert.equal(images,1)
  const rendered=renderDesktopResult({},value);assert.equal(rendered[1].type,'image');assert.equal(rendered[1].attachment.attachmentId,'sha256:fixture');assert.ok(!rendered[0].text.includes(png.toString('base64')))
 }finally{for(const fn of h.disposers)await fn();['inspect','windows','screenshot'].forEach((k,i)=>DesktopApplications.prototype[k]=originals[i])}
})
