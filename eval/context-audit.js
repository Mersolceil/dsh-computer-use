// Read-only observation-volume audit. These are text characters, not tokens,
// provider requests, billed usage, or an implemented history pruning policy.
import { readFile, writeFile } from 'node:fs/promises'
import { modelObservation } from '../src/accessibility.js'
const path = process.argv[2]
if (!path) throw Error('Usage: node eval/context-audit.js trace.jsonl [report.json]')
const rows = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const observations = rows.filter(r => r.type === 'observation').map(r => modelObservation(r.value))
if (!observations.length) throw Error('No observations found')
const sizes = observations.map(o => Array.from(JSON.stringify(o)).length)
let prefix = 0, cumulative = 0, rolling = 0
const steps = sizes.map((size, index) => {
  prefix += size; cumulative += prefix
  const latestTwo = sizes.slice(Math.max(0, index - 1), index + 1).reduce((a,b)=>a+b,0)
  rolling += latestTwo
  return { observation: index + 1, current_chars: size, append_all_history_chars: prefix, hypothetical_latest_two_chars: latestTwo }
})
const report = {
  scope: 'Isolated text observation component only. Hypothetical rolling window is NOT installed; facts/actions/plan/retrieval overhead and image tokens excluded. No claims about task success or billed savings.',
  measurement: 'Unicode code points of JSON after the same modelObservation projection used by the plugin; not token counts.',
  observations: sizes.length,
  screenshot_results: rows.filter(r=>r.type==='result'&&r.action==='screenshot'&&r.ok).length,
  final_append_all_chars: prefix,
  final_latest_two_chars: steps.at(-1).hypothetical_latest_two_chars,
  summed_observation_input_chars_append_all: cumulative,
  summed_observation_input_chars_latest_two: rolling,
  steps,
}
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
