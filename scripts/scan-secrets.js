// Scan project files and decompressed DSH append logs without displaying matches.
import{readdir,readFile,writeFile,mkdir}from'node:fs/promises'
import{join,resolve,dirname}from'node:path'
import{decodeDshLog}from'../eval/dsh-log.js'
const root=resolve('.'),findings=[]
let files=0,logs=0,skippedLinks=0
const pattern=/sk-[A-Za-z0-9_-]{24,}/g
const output=process.argv.includes('--output')?process.argv[process.argv.indexOf('--output')+1]:'.artifacts/secret-scan.json'
const caches=new Set(['.artifacts/browsers','.artifacts/browsers163','.artifacts/npm-cache'])
async function scan(dir){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  if(['node_modules','.git','release'].includes(entry.name))continue
  const path=join(dir,entry.name)
  if(caches.has(path.slice(root.length+1)))continue
  if(entry.isSymbolicLink()){skippedLinks++;continue}
  if(entry.isDirectory()){await scan(path);continue}
  if(!entry.isFile())continue
  const data=await readFile(path);files++
  let value=data.toString('utf8')
  if(path.endsWith('.jsonl.zstd')){value=JSON.stringify(decodeDshLog(data));logs++}
  if(pattern.test(value))findings.push(path.slice(root.length+1))
  pattern.lastIndex=0
 }
}
await scan(root)
const report={date:new Date().toISOString(),scope:'Project files except node_modules, .git, release archives, generated browser/npm caches and symlinks; DSH jsonl.zstd logs decompressed. Archive contents are checked during packaging.',files_scanned:files,decompressed_dsh_logs:logs,symlinks_skipped:skippedLinks,findings,pattern:'API-key-shaped sk- tokens; not a complete generic privacy scrub.'}
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
if(findings.length)process.exitCode=1
