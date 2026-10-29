import { AccessibilityReader } from './accessibility.js'
import { VisualReader } from './visual.js'

export class BrowserTabs {
  constructor(session) {
    this.session = session
    this.records = new Map()
    this.sequence = 0
    this.useSequence = 0
    this.cleanupJobs = new Set()
    this.knownTargets = new Set()
  }

  get active() { return this.records.get(this.activeId) }
  track(job) {
    this.cleanupJobs.add(job)
    void job.catch(() => {}).finally(() => this.cleanupJobs.delete(job))
  }

  register(page) {
    const existing = [...this.records.values()].find(tab => tab.page === page)
    if (existing) return existing
    if (this.records.size >= this.session.config.maxTabs) {
      this.track(page.close().catch(() => {}))
      throw this.session.error('TAB_LIMIT', 'Maximum number of tabs reached. Close a tab before creating another.')
    }
    const id = `t${++this.sequence}`
    const tab = { id, page, lastUsed: ++this.useSequence, blankOriginAllowed: false }
    const owner = this.session
    // Each reader has a fixed page, even while the active tab changes or closes.
    const view = {
      tabId: id, page,
      get config() { return owner.config },
      get activeSignal() { return owner.activeSignal },
      get allowBlankDocument() { return tab.blankOriginAllowed },
      get ax() { return tab.ax },
      error: (code, message) => owner.error(code, message),
      checkUrl: value => owner.checkUrl(value),
    }
    tab.ax = new AccessibilityReader(view)
    tab.visual = new VisualReader(view)
    this.records.set(id, tab)
    if (!this.activeId) this.activeId = id
    page.setDefaultTimeout(owner.config.timeoutMs)
    page.setDefaultNavigationTimeout(owner.config.timeoutMs)
    page.on('framenavigated', frame => {
      owner.uploads.invalidateTab(id)
      tab.blankOriginAllowed = false
      tab.visual.invalidate()
      this.track(tab.ax.clear())
      if(frame===page.mainFrame())this.track(owner.log({type:'navigation',navigation_sequence:++owner.navigationSequence,tab_id:id,url:frame.url(),navigation_epoch:tab.ax.epoch}))
    })
    page.on('dialog', dialog => {
      tab.dialog = { type: dialog.type(), message: dialog.message().slice(0, 500), dismissed: true }
      void dialog.dismiss().catch(() => {})
    })
    page.on('download', download => { void download.cancel().catch(() => {}) })
    // Registering a listener intercepts the chooser without a native OS dialog.
    // Local paths are supplied later by an explicit, scoped upload call.
    page.on('filechooser', chooser => owner.uploads.capture(tab, chooser))
    page.on('close', () => {
      owner.uploads.invalidateTab(id)
      this.records.delete(id)
      tab.visual.invalidate()
      this.track(tab.ax.clear())
      if (this.activeId === id) this.activeId = [...this.records.values()].sort((a, b) => b.lastUsed - a.lastUsed)[0]?.id
      owner.tabEvents.push({ type: 'tab_closed', tab_id: id, active_tab_id: this.activeId || null })
      if (owner.tabEvents.length > 30) owner.tabEvents.shift()
    })
    this.track(page.opener().then(opener => {
      tab.openerId = [...this.records.values()].find(record => record.page === opener)?.id
    }))
    owner.tabEvents.push({ type: 'tab_created', tab_id: id, active_tab_id: this.activeId })
    if (owner.tabEvents.length > 30) owner.tabEvents.shift()
    return tab
  }

  get(id) {
    const tab = this.records.get(id)
    if (!tab || tab.page.isClosed()) throw this.session.error('UNKNOWN_TAB', 'Tab was closed or its tab_id was never issued. Read cu_browser_tabs again.')
    return tab
  }

  async activate(id) {
    const tab = this.get(id)
    this.active?.visual.invalidate()
    tab.visual.invalidate()
    this.activeId = id
    tab.lastUsed = ++this.useSequence
    // Headless shell needs its virtual page activated for animation frames and
    // actionability checks. It has no Chrome.app window or Dock activation.
    await tab.page.bringToFront()
    return tab
  }

  async cdp(tab) {
    return tab.cdpPromise ??= (async()=>{
      const client=await this.session.context.newCDPSession(tab.page)
      const {targetInfo}=await client.send('Target.getTargetInfo')
      tab.nativeTargetId=targetInfo.targetId
      this.knownTargets.add(targetInfo.targetId)
      return client
    })()
  }

  async waitForCount(count,timeout) {
    if(this.records.size>=count)return
    const context=this.session.context,signal=this.session.activeSignal
    if(!context)throw this.session.error('NO_SESSION','Open a browser first.')
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);context.off('page',check);context.off('close',closed);signal?.removeEventListener('abort',aborted)}
      const done=error=>{cleanup();error?reject(error):resolve()}
      const check=()=>{if(this.records.size>=count)done()}
      const closed=()=>done(this.session.error('SESSION_CLOSED','Browser closed while waiting for a tab.'))
      const aborted=()=>done(this.session.error('ABORTED','Tab wait cancelled.'))
      const timer=setTimeout(()=>done(this.session.error('WAIT_TIMEOUT','New tabs are still opening. Inspect tabs; do not click the opening link again blindly.')),timeout)
      context.on('page',check);context.on('close',closed);signal?.addEventListener('abort',aborted,{once:true})
      if(signal?.aborted)aborted();else check()
    })
  }

  async check(tab) {
    if (!tab || tab.page.isClosed()) throw this.session.error('NO_PAGE', 'Open a URL or create a tab first.')
    const url = tab.page.url()
    if (url === 'about:blank') {
      // A popup may inherit its opener's origin even though location.origin is
      // "null". Check Chromium's own security origin, never a page JS value.
      const { frameTree } = await (await this.cdp(tab)).send('Page.getFrameTree')
      this.session.checkUrl(frameTree.frame.securityOrigin + '/')
      tab.blankOriginAllowed = true
      return
    }
    if (url.startsWith('chrome-error:')) throw this.session.error('PAGE_UNAVAILABLE', 'This tab failed to load. Inspect blocked_origins, then navigate to an allowed URL or close the tab.')
    this.session.checkUrl(url)
  }

  async history(tab) {
    const { currentIndex, entries } = await (await this.cdp(tab)).send('Page.getNavigationHistory')
    const meaningful=entries.filter(entry=>entry.url!=='')
    return { currentIndex:meaningful.findIndex(entry=>entry.id===entries[currentIndex]?.id), entries:meaningful }
  }

  async summary() {
    const tabs = await Promise.all([...this.records.values()].map(async tab => {
      await this.cdp(tab).catch(()=>{})
      const url = tab.page.url()
      let title = ''
      try {
        if (url === 'about:blank') title = await tab.page.title()
        else { this.session.checkUrl(url); title = await tab.page.title() }
      } catch { /* Failed or navigating tabs remain listable and closeable. */ }
      return { tab_id: tab.id, url, title, active: tab.id === this.activeId,
        ...(tab.openerId ? { opener_tab_id: tab.openerId } : {}) }
    }))
    const pending=[...new Map([...(this.session.guard?.targets.values()||[])].filter(target=>target.type==='page'&&!this.knownTargets.has(target.targetId)).map(target=>[target.targetId,target])).values()]
    return { active_tab_id: this.activeId || null, tabs, opening_tabs:pending.map(target=>({status:'opening',url:target.navigationUrl||target.url||''})), max_tabs: this.session.config.maxTabs, tab_events: this.session.tabEvents.slice(-5) }
  }

  async dispose() {
    await Promise.allSettled([...this.records.values()].map(tab => tab.ax.clear()))
    await Promise.allSettled([...this.cleanupJobs])
    this.records.clear()
    this.activeId = undefined
    this.knownTargets.clear()
  }
}
