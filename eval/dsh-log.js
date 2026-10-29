import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { isDeepStrictEqual } from 'node:util'

// DSH stores each append as a zstd frame. A single decompressSync invocation
// reads only the first frame on the supported Node version.
export function decodeDshLog(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = buffer.indexOf(magic); i >= 0; i = buffer.indexOf(magic, i + 4)) offsets.push(i)
  const parts = []
  for (let i = 0; i < offsets.length; i++) {
    try { parts.push(zstdDecompressSync(buffer.subarray(offsets[i], offsets[i + 1] ?? buffer.length))) }
    catch { break } // An interrupted writer can leave an incomplete last frame.
  }
  return Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean).map(JSON.parse)
}

export async function readDshEvents(directory) {
  const events = []
  for (const file of await readdir(directory, { recursive: true }).catch(() => [])) {
    if (file.endsWith('.jsonl.zstd')) events.push(...decodeDshLog(await readFile(join(directory, file))))
  }
  return events
}

// Native images are tool content. PTC emits deferred image context as a later
// user/message; require its attachment ID to match a real subtool dispatch.
export function dshImageEvidence(events) {
  const imageIds=content=>(content||[]).filter(b=>b.type==='image').map(b=>b.attachment?.attachmentId).filter(Boolean)
  const native=events.filter(e=>e.type==='tool/result'&&e.surfaceOp==='append'&&!e.data?.message?.isError).flatMap(e=>imageIds(e.data?.message?.content))
  const dispatched=events.filter(e=>e.type==='tool/ptc-dispatch'&&!e.data?.isError&&imageIds(e.data?.content).length)
  const used=new Set(),delivered=[]
  for(const e of events){
    if(e.type!=='user/message'||e.surfaceOp!=='append'||e.data?.source?.kind!=='ptc-mode'||!Number.isSafeInteger(e.seq))continue
    const match=dispatched.findIndex((d,i)=>!used.has(i)&&Number.isSafeInteger(d.seq)&&d.seq<e.seq&&isDeepStrictEqual(d.data.content,e.data.content))
    if(match>=0){used.add(match);delivered.push(...imageIds(e.data.content))}
  }
  return {native_image_blocks:native.length,ptc_delivered_image_blocks:delivered.length,delivered_image_blocks:native.length+delivered.length}
}
