export const name='cu-desktop-eval-policy'
export const inject=['tools','agents']
export function apply(ctx){ctx.on('agent/created',({agent})=>agent.ctx.tools.restrict({allow:['cu_desktop_attach','cu_desktop_observe','cu_desktop_click','cu_desktop_fill','cu_desktop_confirm','cu_desktop_close']}))}
