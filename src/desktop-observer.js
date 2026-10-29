import { execFile } from 'node:child_process'

// Experimental adapter. This is not registered as a DSH tool until the native
// helper, TCC identity, lifetime and interaction protocol are validated.
const MAX_OUTPUT = 512 * 1024
const bundlePattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/
// Only accept the helper's documented read-only fields. A malformed helper
// must not smuggle AX values or an unbounded tree into the model context.
function validTree(windows,expectedCount){
  let count=0
  const visit=(node,depth)=>{
    if(!node||typeof node!=='object'||Array.isArray(node)||depth>8||++count>200)return false
    if(Object.keys(node).some(k=>!['role','title','description','children'].includes(k)))return false
    if(typeof node.role!=='string'||!node.role||Buffer.byteLength(node.role,'utf8')>4096)return false
    for(const key of ['title','description'])if(node[key]!==undefined&&(typeof node[key]!=='string'||!node[key]||Buffer.byteLength(node[key],'utf8')>4096))return false
    return node.children===undefined||(Array.isArray(node.children)&&node.children.every(child=>visit(child,depth+1)))
  }
  return windows.every(node=>visit(node,0))&&count===expectedCount
}
function executeFile(path, args, options) {
  return new Promise((resolve, reject) => {
    execFile(path, args, options, (error, stdout) => {
      if (error && (error.killed || error.code === 'ABORT_ERR' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || !stdout)) return reject(error)
      if (error) {
        // A helper that exits unsuccessfully may report a structured error,
        // but its output must never be accepted as a successful observation.
        try { if (JSON.parse(stdout)?.ok !== false) return reject(error) }
        catch { return reject(error) }
      }
      resolve(stdout)
    })
  })
}

export function createDesktopObserver({helperPath, allowedBundleIds, execute = executeFile}) {
  if (typeof helperPath !== 'string' || !helperPath.startsWith('/') || helperPath.includes('\0')) throw Error('An absolute helper path is required')
  if (!Array.isArray(allowedBundleIds) || allowedBundleIds.some(id => typeof id !== 'string' || !bundlePattern.test(id))) throw Error('Invalid allowed application list')
  const allowed = new Set(allowedBundleIds)
  return Object.freeze({
    async observe({pid, bundleId}, {signal} = {}) {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647 || typeof bundleId !== 'string' || !bundlePattern.test(bundleId)) throw Error('Invalid application target')
      if (!allowed.has(bundleId)) return {ok:false,error:'APPLICATION_NOT_ALLOWED'}
      let output
      try {
        output = await execute(helperPath, [String(pid), bundleId], {encoding:'utf8', timeout:8000, maxBuffer:MAX_OUTPUT, signal, windowsHide:true})
      } catch (error) {
        signal?.throwIfAborted()
        return {ok:false,error:'DESKTOP_HELPER_FAILED'}
      }
      signal?.throwIfAborted()
      if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT) return {ok:false,error:'INVALID_HELPER_OUTPUT'}
      let value
      try { value = JSON.parse(output) } catch { return {ok:false,error:'INVALID_HELPER_OUTPUT'} }
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') return {ok:false,error:'INVALID_HELPER_OUTPUT'}
      if (!value.ok) return {ok:false,error:typeof value.error === 'string' && /^[A-Z_]{1,64}$/.test(value.error) ? value.error : 'DESKTOP_HELPER_FAILED'}
      if (Object.keys(value).some(k=>!['ok','pid','bundle_id','role','windows','nodes','truncated','timed_out','values_read'].includes(k)) || value.pid !== pid || value.bundle_id !== bundleId || value.role !== 'AXApplication' || !Array.isArray(value.windows) || value.values_read !== false || !Number.isSafeInteger(value.nodes) || value.nodes < 0 || value.nodes > 200 || typeof value.truncated !== 'boolean' || typeof value.timed_out !== 'boolean' || (value.timed_out&&!value.truncated) || !validTree(value.windows,value.nodes)) return {ok:false,error:'INVALID_HELPER_OUTPUT'}
      return value
    },
  })
}
