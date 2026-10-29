// One in-memory test key can serve sequential isolated tests. Stop at the
// first failure and retain each runner's report rather than masking failure.
import {spawn} from 'node:child_process'
import {once} from 'node:events'
const cases=[
 ['scripts/desktop-fixture-smoke.mjs','--control','--dsh-real'],
 ['eval/dsh-run.js','--scenario','long-context','--mode','native','--variant','baseline'],
 ['eval/dsh-run.js','--scenario','long-context','--mode','native','--variant','witness'],
 ['eval/dsh-run.js','--scenario','long-context','--mode','ptc','--variant','baseline'],
 ['eval/dsh-run.js','--scenario','long-context','--mode','ptc','--variant','witness'],
]
const selected=process.argv.includes('--ptc-only')?cases.filter(args=>args.includes('ptc')):process.argv.includes('--browser-only')?cases.slice(1):cases
for(const args of selected){
 console.log('Acceptance: '+args.join(' '))
 const child=spawn(process.execPath,args,{env:process.env,stdio:'inherit'})
 const [code]=await once(child,'close')
 if(code!==0){console.error('Acceptance stopped at first failure; inspect the retained report.');process.exitCode=code??1;break}
}
