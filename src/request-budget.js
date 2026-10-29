// Read-only diagnostics for the currently committed DSH surface. At the
// agent/request hook the next user message, final prompt and tool schemas may
// not yet be admitted, so this is never a hard cap or final request count.
export function budgetSnapshot({measurement,pressure,header,contextRoute,imageCount,imagePricingKnown,reserveTokens}){
 if(!measurement||!Number.isFinite(measurement.totalTokens)||measurement.totalTokens<0)throw Error('Invalid host token measurement')
 if(reserveTokens!==undefined&&(!Number.isSafeInteger(reserveTokens)||reserveTokens<0||reserveTokens>10000000))throw Error('Invalid output reserve')
 if(!Number.isSafeInteger(imageCount)||imageCount<0)throw Error('Invalid image count')
 const capacity=Number.isSafeInteger(pressure?.contextWindow)&&pressure.contextWindow>0?pressure.contextWindow:null
 const reserve=reserveTokens??null
 const total=measurement.totalTokens
 const routeMatches=!!(header?.config?.provider&&header?.config?.model&&contextRoute?.provider===header.config.provider&&contextRoute?.model===header.config.model)
 const ratio=capacity!==null&&reserve!==null&&routeMatches&&(imageCount===0||imagePricingKnown)?(total+reserve)/capacity:null
 const warnings=['Diagnostic of committed session only: pending user input, refreshed system prompt, current tool schemas and final route may not yet be included.',
  'Host measurement is an estimate or a prior provider-usage baseline plus estimated changes, not the exact next request or a guarantee against context overflow.']
 if(imageCount>0&&!imagePricingKnown)warnings.push('Image token pricing for the last recorded route is unavailable; image cost may be underestimated.')
 if(capacity!==null)warnings.push('Context capacity belongs to the last recorded route and may be stale after a model change.')
 if(!routeMatches)warnings.push('The last recorded capacity and request header have missing or different routes; no utilization is calculated.')
 if(reserve===null)warnings.push('Output reserve was not supplied; no utilization or threshold is calculated.')
 return {ok:true,committed_surface_estimate_tokens:total,baseline_kind:measurement.baseline?.kind??'unknown',last_recorded_context_window:capacity,
  last_recorded_route:header?.config?{provider:header.config.provider??null,model:header.config.model??null}:null,
  active_image_count:imageCount,image_pricing:imageCount===0?'not_needed':imagePricingKnown?'route_available':'unknown',
  route_matches_capacity:routeMatches,output_reserve_tokens:reserve,estimated_utilization:ratio,estimate_band:ratio===null?'unknown':ratio>=0.8?'high':ratio<=0.6?'low':'middle',warnings}
}
export function installBudgetStatus(ctx,config){
 if(!config.budgetStatusEnabled)return
 ctx.inject(['tokenMeter','sessionProjections'],scoped=>{
  scoped.tools.register({name:'cu_browser_budget_status',description:'Estimate the current committed DSH session context using the host meter. This is not the final next request: pending user input, refreshed prompts, changed tool schemas and route can be absent. Optional reserve_tokens is an explicit output allowance. Does not compact or enforce a limit.',
   parameters:{type:'object',properties:{reserve_tokens:{type:'integer',minimum:0,maximum:10000000}},additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>true,
   execute(args,exec){
    exec.signal.throwIfAborted();if(!exec.agent?.session)throw Error('Budget status requires a DSH session')
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>k!=='reserve_tokens'))throw Error('Invalid budget status arguments')
    const session=exec.agent.session,header=session.requestHeader(),contextRoute=session.requestContext(),measurement=scoped.tokenMeter.measure(session),pressure=scoped.sessionProjections.stateOf(session,'contextPressure')
    const imageCount=session.deriveMessages().flatMap(m=>m.content??[]).filter(b=>b.type==='image'&&b.offloaded!==true).length
    let imagePricingKnown=false
    if(imageCount&&header?.config?.provider&&header?.config?.model){try{imagePricingKnown=!!scoped.get('llm')?.imageRequestPricing(header.config.provider,header.config.model)}catch{}}
    return budgetSnapshot({measurement,pressure,header,contextRoute,imageCount,imagePricingKnown,reserveTokens:args.reserve_tokens})
   }})
 })
}
