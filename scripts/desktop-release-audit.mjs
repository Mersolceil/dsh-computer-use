// Read-only audit of the files selected for a future public export. Reports
// filenames/counts only; never print matching secret or personal contents.
import {readFile,readdir,lstat} from 'node:fs/promises'
import {join,relative,resolve} from 'node:path'
const root=resolve(process.argv[2]||'.')
const allowed=['src','native','eval','scripts','test','locale','README.md','LICENSE','package.json','package-lock.json','cordis.patch.yml','icon.svg','docs/DESKTOP-CONTROL.md']
const checks=[['credential_shape',/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],['private_key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],['personal_absolute_path',/\/(?:Users|home)\/[^\s/"'<>]+/g],['email_address',/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g]]
let files=0;const findings=[]
async function scan(path){
 const stat=await lstat(path)
 if(stat.isSymbolicLink()){findings.push({path:relative(root,path),kind:'symlink'});return}
 if(stat.isDirectory()){for(const entry of await readdir(path))await scan(join(path,entry));return}
 files++;const text=await readFile(path,'utf8')
 for(const [kind,re] of checks){const count=[...text.matchAll(re)].length;if(count)findings.push({path:relative(root,path),kind,count})}
}
for(const path of allowed)await scan(join(root,path))
console.log(JSON.stringify({selected_files:files,findings,note:'Heuristic candidate audit only. Findings require review; docs, archives, artifacts and Git history outside this allowlist are not approved for publication.'},null,2))
if(findings.length)process.exitCode=1
