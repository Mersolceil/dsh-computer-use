// Summarize provider-reported per-step usage without treating missing samples
// as zero usage or confusing cumulative task usage with one request's peak.
export function summarizeRequestUsage(events){
 const samples=events.filter(e=>e.type==='status'&&e.phase==='step_end'&&e.usage&&Number.isSafeInteger(e.usage.inputTokens)&&e.usage.inputTokens>=0)
 const totals=[]
 for(const e of samples){
  const u=e.usage,read=u.cacheReadTokens??0,write=u.cacheWriteTokens??0
  if(!Number.isSafeInteger(read)||read<0||!Number.isSafeInteger(write)||write<0)continue
  const total=u.inputTokens+read+write
  if(Number.isSafeInteger(total))totals.push(total)
 }
 return {request_usage_samples:totals.length,peak_request_input_tokens:totals.length?Math.max(...totals):null}
}
