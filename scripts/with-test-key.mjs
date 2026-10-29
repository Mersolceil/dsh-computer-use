// macOS secure input: capture the hidden answer only in process memory, then
// pass it to the child environment. Never print or persist the answer.
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
if(process.platform!=='darwin')throw Error('Use DEEPSEEK_API_KEY in your process environment on this platform')
const args=process.argv.slice(2)
if(!args.length)throw Error('Provide a Node script and arguments')
let key=process.env.DEEPSEEK_API_KEY
if(!key){
 try{
  const result=await promisify(execFile)('/usr/bin/osascript',['-e','text returned of (display dialog "请只粘贴原始测试 API Key（通常以 sk- 开头），不要说明文字、引号或空格。凭据只存于测试进程内存，不写入文件。" default answer "" with hidden answer buttons {"取消", "开始测试"} default button "开始测试" with title "DSH 项目测试凭据")'],{maxBuffer:8192,timeout:300000})
  key=result.stdout.trim()
 }catch{console.error('Test credential entry cancelled or unavailable.');process.exit(2)}
}
if(!key||!/^[-A-Za-z0-9_]{16,4096}$/.test(key)){console.error('Test credential format rejected; enter the raw ASCII key alone. Input was not displayed or saved.');process.exit(2)}
const child=spawn(process.execPath,args,{env:{...process.env,DEEPSEEK_API_KEY:key},stdio:'inherit'})
key=undefined
child.once('error',()=>{console.error('Unable to start test process.');process.exitCode=1})
const [code]=await once(child,'close');process.exitCode=code??1
