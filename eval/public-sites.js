// Optional real-site integration checks. These are deterministic browser checks,
// not model scores; W3C APG examples are public, client-side interactive demos.
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {BrowserSession} from '../src/browser.js'
const root=resolve('.artifacts/public-sites',new Date().toISOString().replaceAll(':','-'))
await mkdir(root,{recursive:true})
const cases=[
 {id:'w3c-checkbox',path:'checkbox/examples/checkbox/',query:'Lettuce',role:'checkbox',name:'Lettuce',action:'check',args:{checked:true},verify:async s=>await s.page.getByRole('checkbox',{name:'Lettuce',exact:true}).getAttribute('aria-checked')==='true'},
 {id:'w3c-tabs',path:'tabs/examples/tabs-automatic/',query:'Carl Andersen',role:'tab',name:'Carl Andersen',action:'click',args:{},verify:async s=>await s.page.getByRole('tab',{name:'Carl Andersen',exact:true}).getAttribute('aria-selected')==='true' && await s.page.getByRole('tabpanel',{name:'Carl Andersen',exact:true}).isVisible()},
]
const results=[]
for(const c of cases){
 const s=new BrowserSession({headless:true,allowedOrigins:['https://www.w3.org'],artifactDir:join(root,'traces'),timeoutMs:20000,maxObservationNodes:60,maxTreeChars:4500})
 let result={id:c.id,url:'https://www.w3.org/WAI/ARIA/apg/patterns/'+c.path,success:false}
 try{
  const opened=await s.run('open',{url:result.url});if(!opened.ok)throw Error(opened.error_code+': '+opened.message)
  // These examples attach their handlers on window load. DOMContentLoaded is
  // insufficient even when the semantic node is already present.
  const ready=await s.run('wait',{load_state:'load',timeout_ms:20000});if(!ready.ok)throw Error(ready.error_code+': '+ready.message)
  const found=await s.run('find',{query:c.query});if(!found.ok)throw Error(found.error_code+': '+found.message)
  const target=found.elements.find(e=>e.role===c.role&&e.name===c.name);if(!target)throw Error('Semantic target not found')
  const action=await s.run(c.action,{target:target.ref,...c.args});if(!action.ok)throw Error(action.error_code+': '+action.message)
  result.success=Boolean(await c.verify(s));result.browser=s.browser.version();result.trace_path=s.tracePath
  await s.page.screenshot({path:join(root,c.id+'.png')})
 }catch(e){result.error=e.message}finally{await s.shutdown()}
 results.push(result);console.log((result.success?'PASS ':'FAIL ')+c.id+(result.error?' '+result.error:''))
}
const report={date:new Date().toISOString(),mode:'deterministic-public-site-integration',note:'Two W3C APG examples; no model calls. Does not establish broad website compatibility.',passed:results.filter(r=>r.success).length,total:results.length,results}
await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));console.log('Report: '+join(root,'report.json'))
if(report.passed!==report.total)process.exitCode=1
