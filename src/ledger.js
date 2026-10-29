// Pure ledger rules: claims are not verified outcomes. Corrections append a new
// revision and explicitly supersede the old decision; evidence is never inferred.
const KINDS = new Set(['goal', 'stage', 'decision', 'result', 'error', 'uncertain'])
export function emptyLedger() { return { revision: 0, entries: [] } }
export function appendLedger(state, input) {
  if (!state || !Array.isArray(state.entries) || state.entries.length >= 256) throw Error('Ledger unavailable or full')
  if (!input || !KINDS.has(input.kind) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw Error('Invalid ledger entry')
  if (!['user','agent','observation','driver'].includes(input.source)) throw Error('Explicit source required')
  if (input.verified === true && input.source !== 'driver') throw Error('Only driver evidence may mark a result verified')
  const evidence = input.evidence ?? []
  if (!Array.isArray(evidence) || evidence.length > 16 || evidence.some(n=>!Number.isSafeInteger(n)||n<0)) throw Error('Invalid evidence pointers')
  if (input.verified === true && !evidence.length) throw Error('Verified outcome requires evidence')
  let supersedes = null
  if (input.supersedes !== undefined) {
    const prior = state.entries.find(e=>e.id===input.supersedes)
    if (!prior || prior.kind !== 'decision' || input.kind !== 'decision') throw Error('Correction must reference an existing decision')
    if (state.entries.some(e=>e.supersedes===prior.id)) throw Error('Decision already superseded; correct the latest revision')
    supersedes = prior.id
  }
  const entry = { id:state.revision+1,kind:input.kind,text:input.text.trim(),source:input.source,
    verified:input.verified===true,verification_scope:input.verified===true?'tool_execution':input.source==='user'?'user_request':'unverified_claim',evidence:[...evidence],supersedes }
  return { revision:entry.id,entries:[...state.entries,entry] }
}
export function ledgerView(state) {
  const replaced = new Set(state.entries.map(e=>e.supersedes).filter(x=>x!==null))
  return { revision:state.revision,active:state.entries.filter(e=>!replaced.has(e.id)),superseded:state.entries.filter(e=>replaced.has(e.id)) }
}
