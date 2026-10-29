import test from 'node:test'
import assert from 'node:assert/strict'
import{mkdtemp,mkdir,cp,writeFile,rm}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join}from'node:path'
import{pathToFileURL}from'node:url'
test('installed package provenance records omitted lockfile without inventing a hash',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-packed-provenance-'))
 try{
  for(const sub of ['eval','src','scripts','native'])await mkdir(join(dir,sub))
  await cp(new URL('../eval/provenance.js',import.meta.url),join(dir,'eval/provenance.js'))
  await writeFile(join(dir,'package.json'),JSON.stringify({type:'module',version:'test',dependencies:{}}))
  await writeFile(join(dir,'cordis.patch.yml'),'[]')
  const {sourceProvenance,finishProvenance}=await import(pathToFileURL(join(dir,'eval/provenance.js')))
  const missing=await sourceProvenance()
  assert.equal(missing.sha256['package-lock.json'],null)
  assert.deepEqual(missing.unavailable_files,['package-lock.json'])
  await writeFile(join(dir,'package-lock.json'),'{}')
  const changed=await finishProvenance(missing)
  assert.equal(changed.source_unchanged,false)
  assert.deepEqual(changed.changed_files,['package-lock.json'])
 }finally{await rm(dir,{recursive:true,force:true})}
})
