// Evaluation-only composition: limit the real DSH agent to this plugin's
// tools, and optionally exercise the same Agent.cancel() used by user stop.
import { toolSpecifications } from '../src/plugin.js'

export const name = 'cu-eval-policy'
export const inject = ['tools', 'agents']
export function apply(ctx) {
  const names = [...toolSpecifications.map(([action]) => `cu_browser_${action}`), 'cu_browser_history_index', 'cu_browser_recall', 'cu_browser_memory', 'cu_browser_note']
  if(process.env.CU_DSH_LONG_FLOW==='1')names.push('cu_browser_image_recall','cu_browser_image_pin','cu_browser_image_pins','cu_browser_image_window_status','cu_browser_budget_status')
  const owners=new WeakMap(),ptcCalls=new WeakMap()
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: names })
    owners.set(agent.session,agent)
  })
  if (process.env.CU_DSH_CANCEL === '1') {
    // Nested PTC dispatches execute inside the root waterfall; use the real
    // dispatch-start event to trigger the same Agent.cancel() user-stop path.
    ctx.on('session/event',(session,event)=>{
      if(process.env.CU_DSH_EVAL_MODE!=='ptc'||event.type!=='tool/ptc-dispatch-start'||!event.data?.name?.startsWith('cu_browser_'))return
      const count=(ptcCalls.get(session)||0)+1;ptcCalls.set(session,count)
      if(count===2)setTimeout(()=>owners.get(session)?.cancel({kind:'user'}),1)
    })
    let calls = 0
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.name.startsWith('cu_browser_')) return next()
      calls++
      const timer = calls === 2 ? setTimeout(() => {
        exec.agent.cancel({ kind: 'user' })
      }, 1) : undefined
      try { return await next() }
      finally { clearTimeout(timer) }
    })
  }
}
