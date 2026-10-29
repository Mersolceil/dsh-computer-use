// Build a persistent experimental helper app for explicit TCC setup.
// Never overwrite an existing app: replacing its signature can invalidate its
// accessibility permission. This is not an installer or a release artifact.
import { mkdir, access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

if(process.platform!=='darwin')throw Error('macOS required')
const control=process.argv.includes('--control')
const outputIndex=process.argv.indexOf('--output-root')
if(outputIndex>=0&&!process.argv[outputIndex+1])throw Error('--output-root requires a directory')
const parent=resolve(outputIndex>=0?process.argv[outputIndex+1]:control?'.artifacts/desktop-control-helper':'.artifacts/desktop-helper'),app=join(parent,'DSHDesktopHelper.app'),contents=join(app,'Contents')
await mkdir(parent,{recursive:true})
try { await access(app); throw Error('Helper already exists; do not replace its TCC identity') }
catch(error) { if(error.code!=='ENOENT')throw error }
await mkdir(join(contents,'MacOS'),{recursive:true})
await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${control?'org.dsh.desktophelper.control.experimental':'org.dsh.desktophelper.experimental'}</string><key>CFBundleExecutable</key><string>DSHDesktopHelper</string><key>CFBundleName</key><string>DSH Desktop Helper (Experimental)</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
const run=(program,args)=>{const result=spawnSync(program,args,{encoding:'utf8',timeout:90000});if(result.status!==0)throw Error(`${program} failed: ${result.error?.message??result.stderr}`)}
run('swiftc',['-module-cache-path',join(tmpdir(),'dsh-cu-fixture-swift-cache'),resolve(control?'native/macos/control.swift':'native/macos/observe.swift'),'-o',join(contents,'MacOS','DSHDesktopHelper')])
run('codesign',['--force','--sign','-',app])
run('codesign',['--verify','--strict',app])
console.log(JSON.stringify({app,helper:join(contents,'MacOS','DSHDesktopHelper'),signature:'ad-hoc',experimental:true}))
