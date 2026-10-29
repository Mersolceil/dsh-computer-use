import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BrowserSession} from '../src/browser.js'
import {startLab} from '../eval/lab.js'

async function fixture(t){
  const lab=await startLab({port:0}),dir=await mkdtemp(join(tmpdir(),'cu-visual-'))
  const s=new BrowserSession({headless:true,allowedOrigins:[lab.origin],artifactDir:dir})
  t.after(async()=>{await s.shutdown();await lab.close();await rm(dir,{recursive:true,force:true})})
  assert.equal((await s.run('open',{url:lab.origin})).ok,true)
  await s.page.evaluate(()=>{
    document.body.innerHTML='<canvas width="600" height="250"></canvas><output>未点击</output>'
    document.body.style.margin='0'
    const c=document.querySelector('canvas'),ctx=c.getContext('2d');ctx.fillStyle='green';ctx.fillRect(200,80,120,70)
    window.visualHits=0;c.onclick=e=>{if(e.offsetX>=200&&e.offsetX<320&&e.offsetY>=80&&e.offsetY<150){visualHits++;document.querySelector('output').textContent='画布点击成功'}}
  })
  return {s,lab}
}

test('coordinate fallback operates a canvas through an exact fresh screenshot',async t=>{
  const {s}=await fixture(t)
  const image=await s.run('screenshot')
  assert.equal(image.ok,true,JSON.stringify(image))
  assert.equal(image.visual_context.width,1280)
  assert.equal(image.visual_context.height,720)
  assert.equal(Buffer.from(image.screenshot.data,'base64').readUInt32BE(16),1280)
  const v=await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:260,y:115})
  assert.equal(v.ok,true,JSON.stringify(v))
  assert.equal(await s.page.evaluate(()=>visualHits),1)
  assert.match(v.text,/画布点击成功/)
  assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:260,y:115})).error_code,'STALE_SCREENSHOT')
  assert.equal(await s.page.evaluate(()=>visualHits),1)
})

test('invented ids and out-of-image coordinates never cause clicks',async t=>{
  const {s}=await fixture(t)
  assert.equal((await s.run('pixel_click',{screenshot_id:'invented',x:260,y:115})).error_code,'STALE_SCREENSHOT')
  const image=await s.run('screenshot')
  assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:1280,y:0})).error_code,'INVALID_COORDINATE')
  assert.equal(await s.page.evaluate(()=>visualHits),0)
})

test('DOM changes and prior browser actions invalidate visual coordinates',async t=>{
  const {s}=await fixture(t)
  let image=await s.run('screenshot')
  await s.page.evaluate(()=>document.body.style.paddingTop='30px')
  assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:260,y:115})).error_code,'STALE_SCREENSHOT')
  image=await s.run('screenshot')
  await s.run('press',{key:'Escape'})
  assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:260,y:115})).error_code,'STALE_SCREENSHOT')
  assert.equal(await s.page.evaluate(()=>visualHits),0)
})

test('navigation, scroll and viewport changes invalidate the captured image',async t=>{
  const {s,lab}=await fixture(t)
  await s.page.evaluate(()=>document.body.style.height='3000px')
  for(const mutate of [()=>s.page.evaluate(()=>scrollTo(0,100)),()=>s.page.setViewportSize({width:1000,height:600}),()=>s.page.goto(lab.origin+'/frame')]){
    const image=await s.run('screenshot')
    assert.equal(image.ok,true,JSON.stringify(image))
    await mutate()
    assert.equal((await s.run('pixel_click',{screenshot_id:image.visual_context.screenshot_id,x:20,y:20})).error_code,'STALE_SCREENSHOT')
  }
})

test('only the newest screenshot can supply coordinates and read-only AX queries preserve it',async t=>{
  const {s}=await fixture(t)
  const older=await s.run('screenshot'),newer=await s.run('screenshot')
  assert.notEqual(older.visual_context.screenshot_id,newer.visual_context.screenshot_id)
  // A bad id consumes the attempt, too; capture a third image afterwards.
  assert.equal((await s.run('pixel_click',{screenshot_id:older.visual_context.screenshot_id,x:260,y:115})).error_code,'STALE_SCREENSHOT')
  const third=await s.run('screenshot')
  await s.run('observe');await s.run('find',{query:'未点击'})
  assert.equal((await s.run('pixel_click',{screenshot_id:third.visual_context.screenshot_id,x:260,y:115})).ok,true)
})
