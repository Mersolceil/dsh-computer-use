// Diagnostic only: one ready synthetic window, AX and window metadata. No image.
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {DesktopApplications} from '../src/desktop-apps.js'
import {DesktopSession} from '../src/desktop-session.js'
const dir=await mkdtemp(join(tmpdir(),'dsh-window-readiness-')),contents=join(dir,'Fixture.app/Contents'),bundle='org.dsh.fixture.readycheck',helper=resolve(process.argv[2]),manager=new DesktopApplications({helperPath:helper}),session=new DesktopSession({helperPath:helper,applicationAccess:'standard'})
let child
try{
 await mkdir(join(contents,'MacOS'),{recursive:true});const result=spawnSync('swiftc',['-module-cache-path',join(tmpdir(),'dsh-cu-fixture-swift-cache'),resolve('native/macos/fixture.swift'),'-o',join(contents,'MacOS/Fixture')],{encoding:'utf8',timeout:90000});if(result.status!==0)throw Error(result.stderr)
 await writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Ready Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
 child=spawn(join(contents,'MacOS/Fixture'),[],{stdio:['ignore','pipe','ignore']});let stdout=''
 await new Promise((accept,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture readiness timeout')),5000);child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('READY\n')){clearTimeout(timer);accept()}});child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('exit',()=>{clearTimeout(timer);reject(Error('Fixture exited before ready'))})})
 const inspected=await manager.inspect(child.pid,bundle);if(!inspected.ok)throw Error(JSON.stringify(inspected));const windows=await manager.windows(inspected.application),tree=await session.attach({pid:child.pid,bundleId:bundle,processStart:inspected.application.process_start}),flatten=nodes=>(nodes??[]).flatMap(n=>[n,...flatten(n.children)])
 const report={fixture_ready:true,appkit_frame:stdout.match(/FRAME:([^\n]+)/)?.[1],appkit_level:stdout.match(/LEVEL:([^\n]+)/)?.[1],os_windows:windows.windows,ax_ok:tree.ok,ax_error:tree.error_code??null,ax_nodes:tree.nodes??null,saved_label_visible:flatten(tree.windows).some(n=>n.text==='Saved: 0'),screenshot_calls:0,model_calls:0}
 await mkdir('.artifacts',{recursive:true});await writeFile('.artifacts/desktop-window-readiness.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report))
}finally{await session.close();child?.kill('SIGTERM');await rm(dir,{recursive:true,force:true})}
