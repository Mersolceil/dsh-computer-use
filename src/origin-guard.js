import { readFile } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'

// The browser-level connection uses flattened CDP sessions so new page and
// out-of-process frame targets can be paused BEFORE their first request. A
// page-created popup does not yet have a Playwright Frame at that point.
const FILTER = ['page','iframe'].map(type=>({type,exclude:false})).concat({exclude:true})
const ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: FILTER }

export class OriginGuard {
  constructor(session) {
    this.session = session
    this.pending = new Map()
    this.targets = new Map()
    this.sequence = 0
    this.closing = false
  }

  async start(browser, signal) {
    const root = await browser.newBrowserCDPSession()
    let argv
    try { ({ arguments: argv } = await root.send('Browser.getBrowserCommandLine')) }
    finally { await root.detach().catch(() => {}) }
    const profile = argv?.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
    if (!profile || !isAbsolute(profile)) throw this.session.error('GUARD_SETUP_FAILED', 'The owned Chromium temporary profile was not identified.')
    // This is the temporary profile created by our own launch, never a user's
    // personal browser profile. The random debug port binds only to loopback.
    const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(path)) throw this.session.error('GUARD_SETUP_FAILED', 'Invalid Chromium local debugging endpoint.')
    signal?.throwIfAborted()
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    this.socket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(this.session.error('GUARD_SETUP_FAILED', 'Timed out connecting to the owned browser.')) }, this.session.config.startupTimeoutMs)
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      const abort = () => { socket.close(); finish(signal.reason || this.session.error('ABORTED', 'Browser startup cancelled.')) }
      socket.addEventListener('open', () => finish(), { once: true })
      socket.addEventListener('error', () => finish(this.session.error('GUARD_SETUP_FAILED', 'Cannot connect to the owned browser.')), { once: true })
      socket.addEventListener('close', () => finish(this.session.error('GUARD_SETUP_FAILED', 'Browser connection closed during startup.')), { once: true })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    socket.addEventListener('message', event => this.receive(event.data))
    socket.addEventListener('close', () => {
      this.rejectPending(this.session.error('NETWORK_GUARD_LOST', 'Browser request guard disconnected.'))
      if (!this.closing) this.fail(this.session.error('NETWORK_GUARD_LOST', 'Browser request guard disconnected; the browser was closed.'))
    })
    socket.addEventListener('error', () => {
      if (!this.closing) this.fail(this.session.error('NETWORK_GUARD_LOST', 'Browser request guard failed; the browser was closed.'))
    })
    await this.send('Target.setAutoAttach', ATTACH)
    signal?.throwIfAborted()
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.closing || this.socket?.readyState !== WebSocket.OPEN) return reject(this.session.error('NETWORK_GUARD_LOST', 'Browser guard is closed.'))
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(this.session.error('NETWORK_GUARD_LOST', `Browser guard command timed out: ${method}`))
      }, this.session.config.startupTimeoutMs)
      this.pending.set(id, { resolve, reject, timer, sessionId })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  receive(data) {
    try {
      const message = JSON.parse(data)
      if (message.id) {
        const call = this.pending.get(message.id)
        if (!call) return
        this.pending.delete(message.id); clearTimeout(call.timer)
        if (message.error) call.reject(this.session.error('NETWORK_GUARD_LOST', `Browser guard: ${message.error.message}`))
        else call.resolve(message.result)
      } else if (message.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = message.params
        this.targets.set(sessionId, targetInfo)
        void this.attach(sessionId, targetInfo).catch(error => this.operationFailed(error, sessionId))
      } else if (message.method === 'Target.detachedFromTarget') {
        const { sessionId } = message.params
        this.targets.delete(sessionId)
        this.rejectPending(this.session.error('TARGET_CLOSED', 'Guarded target closed.'), sessionId)
      } else if (message.method === 'Fetch.requestPaused') {
        void this.decide(message.sessionId, message.params).catch(error => this.operationFailed(error, message.sessionId))
      }
    } catch (error) { this.fail(error) }
  }

  async attach(sessionId, target) {
    const pageIds = new Set([...this.targets.values()].filter(t => t.type === 'page').map(t => t.targetId))
    if (target.type === 'page' && pageIds.size > this.session.config.maxTabs) {
      this.session.tabEvents.push({ type: 'tab_limit', message: 'New page closed before loading because maxTabs was reached.' })
      await this.send('Target.closeTarget', { targetId: target.targetId })
      return
    }
    await this.send('Target.setAutoAttach', ATTACH, sessionId)
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId)
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
  }

  recordDenied(value) {
    let origin='opaque'
    try { origin=new URL(value).origin } catch { /* Invalid requests are denied too. */ }
    this.session.networkDenied.push(origin)
    if (this.session.networkDenied.length>100)this.session.networkDenied.shift()
  }

  async decide(sessionId, event) {
    const target=this.targets.get(sessionId)
    if(target&&event.resourceType==='Document'&&!target.navigationUrl)target.navigationUrl=event.request.url
    try { this.session.checkUrl(event.request.url) }
    catch {
      this.recordDenied(event.request.url)
      await this.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sessionId)
      return
    }
    await this.send('Fetch.continueRequest', { requestId: event.requestId }, sessionId)
  }

  operationFailed(error, sessionId) {
    // Target detachment and whole-browser shutdown normally cancel its pending
    // protocol requests. Any other guard failure closes the browser.
    if (!this.closing && this.targets.has(sessionId)) this.fail(error)
  }

  fail(error) {
    if (this.closing) return
    this.session.guardError = error
    this.closing = true
    void this.session.shutdown().catch(() => {})
  }

  rejectPending(error, sessionId) {
    for (const [id, call] of this.pending) if (sessionId === undefined || call.sessionId === sessionId) {
      clearTimeout(call.timer); this.pending.delete(id); call.reject(error)
    }
  }

  beginClose() { this.closing = true }
  dispose() {
    this.closing = true
    this.rejectPending(this.session.error('SESSION_CLOSED', 'Browser closed.'))
    this.socket?.close()
    this.targets.clear()
  }
}
