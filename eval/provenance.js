import {readFile,readdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'

export async function sourceProvenance(){
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
  const paths=['package.json','package-lock.json','cordis.patch.yml']
  for(const dir of ['src','eval','scripts','native'])for(const file of await readdir(new URL('../'+dir+'/',import.meta.url),{recursive:true}))if(/\.(js|mjs|cjs|html|swift)$/.test(file))paths.push(dir+'/'+file)
  const hashes={},unavailable=[]
  for(const path of paths.sort()){
    try{hashes[path]=createHash('sha256').update(await readFile(new URL('../'+path,import.meta.url))).digest('hex')}
    catch(error){
      // npm intentionally omits package-lock.json from packed packages. Do
      // not fabricate its fingerprint or treat installed tests as checkout tests.
      if(path!=='package-lock.json'||error.code!=='ENOENT')throw error
      hashes[path]=null;unavailable.push(path)
    }
  }
  return {captured_at:new Date().toISOString(),package_version:pkg.version,node:process.version,platform:process.platform,arch:process.arch,dependencies:pkg.dependencies,sha256:hashes,unavailable_files:unavailable}
}
export async function finishProvenance(start){
  const finish=await sourceProvenance()
  const changed=Object.keys({...start.sha256,...finish.sha256}).filter(p=>start.sha256[p]!==finish.sha256[p])
  return {...start,source_unchanged:changed.length===0,changed_files:changed}
}
