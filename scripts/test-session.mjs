// Restricted, in-memory credential lifetime for sequential acceptance retries.
// Start with with-test-key.mjs. Commands contain test arguments, never secrets.
import{createInterface}from'node:readline'
import{spawn}from'node:child_process'
import{once}from'node:events'
import{open,mkdir}from'node:fs/promises'
import{resolve,join}from'node:path'
if(!process.env.DEEPSEEK_API_KEY)throw Error('Authorized test key required in process memory')
const allowed=new Set(['eval/dsh-run.js','scripts/desktop-fixture-smoke.mjs'])
const dir=resolve('.artifacts/test-session',String(Date.now()));await mkdir(dir,{recursive:true})
let child,number=0
const timer=setTimeout(()=>{child?.kill('SIGINT');process.exitCode=2;process.stdin.destroy();delete process.env.DEEPSEEK_API_KEY},3600000)
timer.unref()
console.log(JSON.stringify({status:'ready',credential:'memory_only',expires_after_minutes:60}))
try{
 for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  let command;try{command=JSON.parse(line)}catch{console.log(JSON.stringify({error:'INVALID_COMMAND'}));continue}
  if(command.stop===true)break
  const args=command.args
  if(!Array.isArray(args)||!allowed.has(args[0])||args.length>20||args.some(x=>typeof x!=='string'||x.length>1000)){console.log(JSON.stringify({error:'TEST_NOT_ALLOWED'}));continue}
  const path=join(dir,`${++number}.log`),file=await open(path,'w',0o600)
  try{
   child=spawn(process.execPath,args,{env:process.env,stdio:['ignore',file.fd,file.fd]})
   console.log(JSON.stringify({status:'running',case:number,pid:child.pid,script:args[0],log:path}))
   const [code]=await once(child,'close')
   console.log(JSON.stringify({status:'finished',case:number,exit:code,log:path}))
  }finally{child=undefined;await file.close()}
 }
}finally{clearTimeout(timer);delete process.env.DEEPSEEK_API_KEY;process.stdin.destroy()}
