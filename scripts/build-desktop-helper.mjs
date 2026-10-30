// Build a persistent experimental helper app for explicit TCC setup.
// Never overwrite an existing app: replacing its signature can invalidate its
// accessibility permission. This is not an installer or a release artifact.
import { mkdir, access, writeFile,readFile,mkdtemp,rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

if(process.platform!=='darwin')throw Error('macOS required')
const control=process.argv.includes('--control')
const outputIndex=process.argv.indexOf('--output-root')
if(outputIndex>=0&&!process.argv[outputIndex+1])throw Error('--output-root requires a directory')
const parent=resolve(outputIndex>=0?process.argv[outputIndex+1]:control?'.artifacts/desktop-control-helper':'.artifacts/desktop-helper'),app=join(parent,'DSHDesktopHelper.app'),contents=join(app,'Contents')
const packageVersion=JSON.parse(await readFile(resolve('package.json'),'utf8')).version
await mkdir(parent,{recursive:true})
try { await access(app); throw Error('Helper already exists; do not replace its TCC identity') }
catch(error) { if(error.code!=='ENOENT')throw error }
await mkdir(join(contents,'MacOS'),{recursive:true})
await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${control?'org.dsh.desktophelper.control.experimental':'org.dsh.desktophelper.experimental'}</string><key>CFBundleExecutable</key><string>DSHDesktopHelper</string><key>CFBundleName</key><string>DSH Desktop Helper (Experimental)</string><key>CFBundleShortVersionString</key><string>${packageVersion}</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:90000});if(result.status!==0)throw Error(`${program} failed: ${result.error?.message??result.stderr}`)}
const build=await mkdtemp(join(tmpdir(),'dsh-cu-build-'))
try{
 let source=resolve('native/macos/observe.swift')
 if(control){source=join(build,'main.swift');await writeFile(source,(await readFile(resolve('native/macos/applications.swift'),'utf8'))+'\n'+(await readFile(resolve('native/macos/capture.swift'),'utf8'))+'\n'+(await readFile(resolve('native/macos/visual.swift'),'utf8'))+'\n'+(await readFile(resolve('native/macos/preview.swift'),'utf8'))+'\n'+(await readFile(resolve('native/macos/approval.swift'),'utf8'))+'\n'+(await readFile(resolve('native/macos/control.swift'),'utf8')))}
 run('swiftc',['-module-cache-path',join(tmpdir(),'dsh-cu-fixture-swift-cache'),source,'-o',join(contents,'MacOS','DSHDesktopHelper')])
}finally{await rm(build,{recursive:true,force:true})}
run('codesign',['--force','--sign','-',app])
run('codesign',['--verify','--strict',app])
console.log(JSON.stringify({app,helper:join(contents,'MacOS','DSHDesktopHelper'),signature:'ad-hoc',experimental:true}))
