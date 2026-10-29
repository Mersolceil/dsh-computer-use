// Isolated DSH agent test. The deterministic provider exercises the real host
// loop; --dsh-real instead uses the authorized key from the process environment.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile,readFile,mkdir } from 'node:fs/promises'
import {createHash} from 'node:crypto'
import { join,resolve } from 'node:path'
import { readDshEvents } from '../eval/dsh-log.js'
import {sourceProvenance,finishProvenance} from '../eval/provenance.js'
export async function desktopDshRun({dir,pid,helper,real=false}){
 const source=await sourceProvenance(),helperSha256=createHash('sha256').update(await readFile(helper)).digest('hex')
 let requests=0,scriptedStep=0,server
 if(real&&!process.env.DEEPSEEK_API_KEY)throw Error('Authorized test key must be supplied through the process environment')
 if(!real){
  server=createServer(async(req,res)=>{
   let raw='';for await(const chunk of req)raw+=chunk
   const body=JSON.parse(raw);requests++
   const values=(body.messages??[]).flatMap(m=>(Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_result').flatMap(b=>{try{return [JSON.parse(typeof b.content==='string'?b.content:b.content?.find(x=>x.type==='text')?.text)]}catch{return []}}))
   const snapshot=values.filter(v=>Array.isArray(v.windows)).at(-1)
   const nodes=tree=>tree.flatMap(n=>[n,...nodes(n.children??[])])
   const field=snapshot?nodes(snapshot.windows).find(n=>n.title==='Task title'&&n.actions?.includes('fill')):null
   const button=snapshot?nodes(snapshot.windows).find(n=>n.title==='Save once'&&n.actions?.includes('click')):null
   const calls=[['cu_desktop_attach',{pid,bundleId:'org.dsh.fixture'}],['cu_desktop_fill',{target:field?.ref,text:'DSH桌面验收'}],['cu_desktop_observe',{}],['cu_desktop_click',{target:button?.ref}],['cu_desktop_observe',{}],['cu_desktop_close',{}]]
   // AX can expose an incomplete tree immediately after the fixture starts.
   // Re-observe before selecting a control; never manufacture an absent ref.
   let call
   if(requests<=20){
    if((scriptedStep===1&&!field)||(scriptedStep===3&&!button))call=['cu_desktop_observe',{}]
    else call=calls[scriptedStep++]
   }
   const events=[{type:'message_start',message:{usage:{input_tokens:100,output_tokens:0}}},{type:'content_block_start',index:0,content_block:call?{type:'tool_use',id:`desktop-${requests}`,name:call[0],input:call[1]}:{type:'text',text:'Desktop fixture finished'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:call?'tool_use':'end_turn'},usage:{output_tokens:5}},{type:'message_stop'}]
   res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  });server.listen(0,'127.0.0.1');await once(server,'listening')
 }
 try{
  const overlay=join(dir,'desktop.yml'),home=join(dir,'dsh-home')
  await writeFile(overlay,`- id: tools\n  config:\n    mode: native\n- id: session-title-llm\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- insert:\n    - id: cu-desktop-plugin\n      name: ${JSON.stringify(resolve('src/desktop-plugin.js'))}\n      config:\n        helperPath: ${JSON.stringify(helper)}\n        allowedBundleIds: [org.dsh.fixture]\n        maxActions: 30\n    - id: cu-desktop-policy\n      name: ${JSON.stringify(resolve('eval/desktop-policy.js'))}\n`)
  const env={...process.env,DSH_HOME:home,...(!real?{DEEPSEEK_API_KEY:'local-desktop-fixture',DEEPSEEK_BASE_URL:`http://127.0.0.1:${server.address().port}`}:{})}
  const child=spawn(process.env.DSH_LAUNCHER||'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',['headless','--patch',overlay,'--json',`仅使用 cu_desktop 工具连接 PID ${pid}、bundleId org.dsh.fixture 的专用测试窗口。填写 Task title 为“DSH桌面验收”，用最新 ref 点击 Save once 恰好一次。每次动作后重新 observe，不能重复保存。确认 Saved: 1，再 close 断开助手，报告结果。不得操作其他应用或使用终端。`],{env,stdio:['ignore','pipe','pipe']})
  let output='',errors='';child.stdout.on('data',c=>{output+=c});child.stderr.on('data',c=>{errors+=c})
  const timer=setTimeout(()=>child.kill('SIGKILL'),180000)
  const [exit]=await once(child,'close');clearTimeout(timer)
  const redact=s=>s.replaceAll(env.DEEPSEEK_API_KEY,'[REDACTED]')
  await writeFile(join(dir,'dsh-events.jsonl'),redact(output));await writeFile(join(dir,'dsh-stderr.txt'),redact(errors))
  const durable=await readDshEvents(join(home,'sessions'))
  const calls=durable.filter(e=>e.type==='tool/call'&&e.data?.name?.startsWith('cu_desktop_'))
  const bad=durable.filter(e=>e.type==='tool/result'&&(e.data?.message?.isError||e.data?.message?.content?.some(b=>b.type==='text'&&b.text.includes('"ok":false'))))
  const nodes=tree=>tree.flatMap(n=>[n,...nodes(n.children??[])])
  const observedSaved=durable.filter(e=>e.type==='tool/result'&&!e.data?.message?.isError).some(e=>{try{const value=JSON.parse(e.data.message.content.find(b=>b.type==='text')?.text);return Array.isArray(value.windows)&&nodes(value.windows).some(n=>n.role==='AXStaticText'&&n.text==='Saved: 1')}catch{return false}})
  const evidence=resolve('.artifacts/desktop-eval',String(Date.now()))
  await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'events.jsonl'),redact(output));await writeFile(join(evidence,'stderr.txt'),redact(errors))
  return {exit,provider:real?'configured-real-provider':'local-scripted-fixture',requests:real?null:requests,desktop_tool_calls:calls.length,tool_errors:bad.length,save_calls:calls.filter(e=>e.data.name==='cu_desktop_click').length,attached:calls.some(e=>e.data.name==='cu_desktop_attach'),detached:calls.some(e=>e.data.name==='cu_desktop_close'),observed_saved_status:observedSaved,helper_sha256:helperSha256,provenance:await finishProvenance(source),evidence_directory:evidence}
 }finally{if(server)await new Promise(resolve=>server.close(resolve))}
}
