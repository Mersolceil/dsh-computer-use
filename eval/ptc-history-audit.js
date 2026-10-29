import { readDshEvents } from './dsh-log.js'
import { compactPtcResult } from '../src/ptc-history.js'

// Read-only audit of an isolated evaluation session. Reports counts only.
// Does not alter DSH messages and does not estimate model tokens.
const directory=process.argv[2]
if(!directory)throw Error('Usage: node eval/ptc-history-audit.js <isolated-session-directory>')
const events=await readDshEvents(directory)
let roots=0,eligible=0,before=0,after=0,unsafeOrUnrecognized=0
for(const result of events.filter(e=>e.type==='tool/result'&&e.surfaceOp==='append')){
 const message=result.data?.message,id=message?.toolCallId
 const starts=events.filter(e=>e.type==='tool/ptc-dispatch-start'&&e.data?.rootCallId===id)
 const ended=events.filter(e=>e.type==='tool/ptc-dispatch'&&e.data?.rootCallId===id)
 if(!starts.length&&!ended.length)continue
 roots++
 const blocks=message.content?.filter(b=>b.type==='text')??[]
 if(message.isError||blocks.length!==1||starts.length!==1||ended.length!==1||starts[0].data.subCallId!==ended[0].data.subCallId){unsafeOrUnrecognized++;continue}
 const compact=compactPtcResult(blocks[0].text,[{...ended[0].data,seq:ended[0].seq}])
 if(!compact){unsafeOrUnrecognized++;continue}
 const original=Array.from(blocks[0].text).length,replacement=Array.from(JSON.stringify(compact)).length
 if(replacement>=original){unsafeOrUnrecognized++;continue}
 eligible++;before+=original;after+=replacement
}
console.log(JSON.stringify({roots,eligible,unsafe_or_unrecognized:unsafeOrUnrecognized,eligible_original_chars:before,eligible_replacement_chars:after,model_calls:0,note:'Read-only matching experiment; not active PTC compression, not token savings or model task success.'},null,2))
