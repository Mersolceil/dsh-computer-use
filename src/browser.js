import { chromium } from 'playwright'
import { mkdir, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserTabs } from './tabs.js'
import { OriginGuard } from './origin-guard.js'
import { OriginProxy } from './origin-proxy.js'
import { BrowserUploads } from './uploads.js'
import { browserInstallCommand } from './runtime.js'

export class BrowserError extends Error {
  constructor(code, message) { super(message); this.name = 'BrowserError'; this.code = code }
}

export function executablePath(config = {}) {
  if (config.executablePath) return config.executablePath
  // Background work must not launch a macOS Chrome/Chromium application that
  // appears in the Dock. Playwright selects its standalone headless shell.
  if (config.headless !== false) return undefined
  if (existsSync(chromium.executablePath())) return chromium.executablePath()
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  return candidates.find(existsSync)
}

export function normalizeConfig(input = {}) {
  const config = {
    taskStateEnabled: false, ledgerEnabled: true, historyEnabled: true, ptcHistoryEnabled: false, ptcCompactDuplicatesEnabled: false, imagePinsEnabled: false, imageWindowEnabled: false, imageWindowKeep: 2, budgetStatusEnabled: false, historyKeepRecent: 4, headless: true, allowedOrigins: ['http://127.0.0.1:4173'],
    artifactDir: resolve('.computer-use-v1'), maxSteps: 100,
    timeoutMs: 10000, startupTimeoutMs: 30000, idleMs: 600000, maxElements: 100,
    maxTreeChars: 16000, observationDepth: 15, maxObservationNodes: 300, maxTrackedRefs: 1500, maxTabs: 8,
    uploadRoots: [], maxUploadFiles: 5, maxUploadBytes: 10 * 1024 * 1024, ...input,
  }
  for (const key of ['maxSteps', 'timeoutMs', 'startupTimeoutMs', 'idleMs', 'maxElements', 'maxTreeChars', 'observationDepth', 'maxObservationNodes', 'maxTrackedRefs', 'maxTabs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`)
  }
  if (config.maxTreeChars < 500 || config.observationDepth > 50) throw new Error('maxTreeChars must be >=500 and observationDepth <=50')
  if (config.maxTrackedRefs < config.maxObservationNodes) throw new Error('maxTrackedRefs must be >= maxObservationNodes so issued refs remain usable')
  if (config.maxTabs > 20) throw new Error('maxTabs must be <=20')
  if (!Array.isArray(config.uploadRoots) || config.uploadRoots.some(p => typeof p !== 'string' || !isAbsolute(p) || p.includes('\0'))) throw new Error('uploadRoots must contain absolute directory paths')
  if (!Number.isSafeInteger(config.maxUploadFiles) || config.maxUploadFiles < 1 || config.maxUploadFiles > 20) throw new Error('maxUploadFiles must be 1..20')
  if (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes < 1 || config.maxUploadBytes > 100 * 1024 * 1024) throw new Error('maxUploadBytes must be 1..104857600')
  if (typeof config.taskStateEnabled !== 'boolean') throw new Error('taskStateEnabled must be boolean')
  if (typeof config.ptcHistoryEnabled !== 'boolean') throw new Error('ptcHistoryEnabled must be boolean')
  if (typeof config.ptcCompactDuplicatesEnabled !== 'boolean') throw new Error('ptcCompactDuplicatesEnabled must be boolean')
  if (typeof config.imagePinsEnabled !== 'boolean') throw new Error('imagePinsEnabled must be boolean')
  if (typeof config.imageWindowEnabled !== 'boolean') throw new Error('imageWindowEnabled must be boolean')
  if (typeof config.budgetStatusEnabled !== 'boolean') throw new Error('budgetStatusEnabled must be boolean')
  if (!Number.isSafeInteger(config.imageWindowKeep)||config.imageWindowKeep<1||config.imageWindowKeep>20) throw new Error('imageWindowKeep must be an integer from 1 to 20')
  if (typeof config.ledgerEnabled !== 'boolean') throw new Error('ledgerEnabled must be boolean')
  if (typeof config.historyEnabled !== 'boolean' || !Number.isSafeInteger(config.historyKeepRecent) || config.historyKeepRecent < 1 || config.historyKeepRecent > 20) throw new Error('historyEnabled must be boolean and historyKeepRecent must be 1..20')
  if (typeof config.headless !== 'boolean') throw new Error('headless must be a boolean')
  if (typeof config.artifactDir !== 'string' || !config.artifactDir) throw new Error('artifactDir must be a path')
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length) throw new Error('allowedOrigins must contain exact HTTP(S) origins')
  config.allowedOrigins = config.allowedOrigins.map(origin => {
    const u = new URL(origin)
    if (!['http:', 'https:'].includes(u.protocol) || u.origin !== origin || u.username || u.password) throw new Error(`Expected exact origin: ${origin}`)
    return u.origin
  })
  return config
}

// References bind real DOM node identity and accessible semantics. Unrelated
// updates and reordering preserve them; navigation/replacement retires them.
export class BrowserSession {
  constructor(input = {}) {
    this.config = normalizeConfig(input)
    this.allowed = new Set(this.config.allowedOrigins)
    this.tabEvents = []
    this.navigationSequence = 0
    this.tabs = new BrowserTabs(this)
    this.uploads = new BrowserUploads(this)
    this.steps = 0
    this.observation = 0
    this.busy = false
    this.closing = false
    this.stopped = false
    this.traceId = randomUUID()
    this.tracePath = join(this.config.artifactDir, `${this.traceId}.jsonl`)
    this.networkDenied = []
  }

  get page() { return this.tabs.active?.page }
  get ax() { return this.tabs.active?.ax }
  get refs() { return this.ax?.references }
  get visual() { return this.tabs.active?.visual }

  error(code, message) { return new BrowserError(code, message) }

  checkUrl(value) {
    let url
    try { url = new URL(value) } catch { throw new BrowserError('INVALID_URL', 'Provide an absolute HTTP(S) URL.') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !this.allowed.has(url.origin)) {
      throw new BrowserError('ORIGIN_DENIED', `Origin is not allowed: ${url.origin}. Ask the user to change allowedOrigins; do not bypass this restriction.`)
    }
    return url.href
  }

  checkWebSocketUrl(value) {
    let url
    try { url = new URL(value) } catch { throw new BrowserError('ORIGIN_DENIED', 'Invalid WebSocket URL.') }
    if (!['ws:','wss:'].includes(url.protocol)) throw new BrowserError('ORIGIN_DENIED', 'Unsupported WebSocket protocol.')
    url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
    this.checkUrl(url.href)
  }

  async log(event) {
    await mkdir(this.config.artifactDir, { recursive: true, mode: 0o700 })
    await appendFile(this.tracePath, JSON.stringify({ time: new Date().toISOString(), trace_id: this.traceId, ...event }) + '\n', { mode: 0o600 })
  }

  async start(signal) {
    signal?.throwIfAborted()
    await this.uploads.initialize()
    const path = executablePath(this.config)
    if (!path && !this.config.headless) throw new BrowserError('BROWSER_MISSING', 'Install a visible Chromium/Chrome browser, or use the default standalone headless shell.')
    // No browser profile is imported. Service workers are blocked so all
    // ordinary page requests pass through the origin policy below.
    this.proxy=new OriginProxy(this)
    const proxyUrl=await this.proxy.start(signal)
    let browser
    try { browser = await chromium.launch({ headless: this.config.headless, ...(path?{executablePath:path}:{channel:'chromium-headless-shell'}), chromiumSandbox: true, timeout: this.config.startupTimeoutMs,
      proxy:{server:proxyUrl,bypass:'<-loopback>'},
      args: ['--enable-automation', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1','--disable-http2','--disable-quic'] }) }
    catch(error){await this.proxy.dispose();if(!path&&error.message.includes('Executable doesn\'t exist'))throw new BrowserError('BROWSER_MISSING',`Install the matching standalone runtime with: ${browserInstallCommand}. Then retry open. There is no automatic fallback to the Chrome app.`);throw error}
    this.browser = browser
    if (this.stopped || signal?.aborted) { await browser.close(); this.browser = undefined; signal?.throwIfAborted(); throw new BrowserError('ABORTED', 'Browser stopped during startup.') }
    try {
      this.guard = new OriginGuard(this)
      await this.guard.start(browser, signal)
      signal?.throwIfAborted()
      if (this.stopped) throw new BrowserError('ABORTED', 'Browser stopped during guard startup.')
      this.context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: 'block' })
      this.context.on('page', page => {
        try { this.tabs.register(page) }
        catch (error) {
          void page.close().catch(() => {})
          if (error.code !== 'TAB_LIMIT') this.guard.fail(error)
        }
      })
      await this.context.addInitScript(() => {
        window.__cuRevision = 0
        new MutationObserver(() => { window.__cuRevision++ }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
      })
      this.context.on('close', () => { this.stopped = true })
      this.browserInfo={version:browser.version(),runtime:this.config.headless?(path?'custom-headless':'chromium-headless-shell'):'visible-chromium'}
      await this.log({type:'browser_started',...this.browserInfo})
    } catch (error) {
      await this.shutdown()
      throw error
    }
  }

  async invalidate() {
    for (const tab of this.tabs.records.values()) tab.visual.invalidate()
    await Promise.allSettled([...this.tabs.records.values()].map(tab => tab.ax.clear()))
  }

  async observe(options = {}) {
    for (let attempt=0;;attempt++) {
      try { return await this.observeOnce(options) }
      catch(error) { if (!['PAGE_CHANGED','TAB_CHANGED'].includes(error.code) || attempt>=2 || this.activeSignal?.aborted) throw error }
    }
  }

  async observeOnce(options = {}) {
    const tab = this.tabs.active
    await this.tabs.check(tab)
    const id = `obs_${++this.observation}`
    const semantic = await tab.ax.read(options)
    const url = tab.page.url()
    const title = await tab.page.title()
    const history = await this.tabs.history(tab)
    const tabs = await this.tabs.summary()
    if (this.tabs.active !== tab || tab.page.isClosed()) throw new BrowserError('TAB_CHANGED', 'Active tab changed during observation. Read the selected tab again.')
    if (semantic.navigation_epoch!==tab.ax.epoch || url!==tab.page.url()) throw new BrowserError('PAGE_CHANGED','Document changed while reading page metadata. No mixed-document observation was returned.')
    const value = { observation_id: id, url, title, ...semantic, ...tabs, ...this.uploads.summary(),
      history: { can_back: history.currentIndex > 0, can_forward: history.currentIndex < history.entries.length - 1 },
      supported_scope: 'Official ARIA semantics, open shadow DOM and allowed-origin frames. Prefer element refs; screenshots supplement visual judgment.',
      dialog: tab.dialog || null, blocked_origins: [...new Set(this.networkDenied)].slice(-10) }
    tab.dialog = null
    await this.log({ type: 'observation', value })
    return value
  }

  async target(ref) {
    if (!this.ax) throw new BrowserError('NO_PAGE', 'Select an open tab first.')
    return this.ax.resolve(ref)
  }

  async createTab() {
    if (this.tabs.records.size >= this.config.maxTabs) throw new BrowserError('TAB_LIMIT', 'Close an existing tab before creating another.')
    const page = await this.context.newPage()
    const tab = this.tabs.register(page)
    await this.tabs.activate(tab.id)
    return tab
  }

  async selectedObservation() {
    if (this.tabs.active) return this.observe()
    return { ...await this.tabs.summary(), page_state: 'no_active_tab', next_action: 'Use cu_browser_open or cu_browser_tab_new with an allowed URL. The browser context remains open.' }
  }

  async perform(action, args) {
    if (action === 'tabs') return { ...await this.tabs.summary(), ...this.uploads.summary(), blocked_origins: [...new Set(this.networkDenied)].slice(-10) }
    if (action === 'upload') return { ...await this.uploads.upload(args), ...await this.observe() }
    if(action==='wait'&&args.tab_count!==undefined){await this.tabs.waitForCount(args.tab_count,Math.min(args.timeout_ms||this.config.timeoutMs,this.config.timeoutMs));return this.selectedObservation()}
    if (action === 'tab_close') {
      const tab = this.tabs.get(args.tab_id)
      await tab.page.close()
      return { closed_tab_id: tab.id, ...await this.selectedObservation() }
    }
    if (action === 'tab_switch') {
      await this.tabs.activate(args.tab_id)
      return this.observe()
    }
    if (action === 'open' || action === 'tab_new') {
      const url = this.checkUrl(args.url)
      if (!this.browser) await this.start(this.activeSignal)
      const tab = action === 'tab_new' || !this.tabs.active ? await this.createTab() : this.tabs.active
      await tab.page.goto(url, { waitUntil: 'domcontentloaded' })
    } else {
      const tab = this.tabs.active
      await this.tabs.check(tab)
      const { page, ax, visual } = tab
      if (action === 'observe') return this.observe(args)
      if (action === 'find') return this.observe({ ...args, filter: args.filter || 'all' })
      if (action === 'screenshot') {
        for (let attempt = 0; attempt < 3; attempt++) {
          const observation = await this.observe()
          const picture = await visual.capture()
          if (observation.navigation_epoch === picture.visual_context.navigation_epoch && observation.url === picture.visual_context.url && observation.active_tab_id === picture.visual_context.tab_id) return { ...observation, ...picture }
        }
        throw new BrowserError('PAGE_CHANGED', 'Page kept navigating while combining the screenshot and semantic observation.')
      }
      if (action === 'history') {
        if (args.direction === 'reload') await page.reload({ waitUntil: 'domcontentloaded' })
        else {
          const history = await this.tabs.history(tab)
          const index = history.currentIndex + (args.direction === 'back' ? -1 : 1)
          if (index < 0 || index >= history.entries.length) throw new BrowserError('NO_HISTORY', 'There is no entry in that history direction.')
          const url = history.entries[index].url
          if (url !== 'about:blank') this.checkUrl(url)
          if (args.direction === 'back') await page.goBack({ waitUntil: 'domcontentloaded' })
          else await page.goForward({ waitUntil: 'domcontentloaded' })
        }
      }
      else if (action === 'pixel_click') await visual.click(args)
      else if (action === 'click') await (await ax.resolve(args.target)).click({ timeout: this.config.timeoutMs })
      else if (action === 'fill') await (await ax.resolve(args.target)).fill(args.text, { timeout: this.config.timeoutMs })
      else if (action === 'hover') await (await ax.resolve(args.target)).hover({ timeout: this.config.timeoutMs })
      else if (action === 'check') await (await ax.resolve(args.target)).setChecked(args.checked, { timeout: this.config.timeoutMs })
      else if (action === 'select') {
        const handle = await ax.resolve(args.target)
        const options = await handle.evaluate(el => [...(el.options || [])].map(o => ({ value: o.value, label: o.label })))
        const values = args.values.map(value => {
          if (options.some(o => o.value === value)) return value
          const found = options.filter(o => o.label === value)
          if (found.length !== 1) throw new BrowserError('OPTION_NOT_FOUND', 'Option value or unique label was not found. Observe the select options again.')
          return found[0].value
        })
        await handle.selectOption(values, { timeout: this.config.timeoutMs })
      }
      else if (action === 'wait') {
        if (args.load_state) await page.waitForLoadState(args.load_state,{timeout:Math.min(args.timeout_ms || this.config.timeoutMs,this.config.timeoutMs)})
        else if (args.target) await (await ax.waitHandle(args.target)).waitForElementState(args.state || 'visible', { timeout: Math.min(args.timeout_ms || this.config.timeoutMs, this.config.timeoutMs) })
        else if (typeof args.text === 'string' && args.text.trim()) await page.getByText(args.text, { exact: args.exact ?? false }).first().waitFor({ state: 'visible', timeout: Math.min(args.timeout_ms || this.config.timeoutMs, this.config.timeoutMs) })
        else throw new BrowserError('INVALID_ARGUMENT', 'wait requires a target or visible text.')
      }
      else if (action === 'press') {
        if (!['Enter', 'Tab', 'Shift+Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'ControlOrMeta+A'].includes(args.key)) throw new BrowserError('INVALID_KEY', 'Key is not in the supported key list.')
        if (args.target) await (await ax.resolve(args.target)).press(args.key)
        else await page.keyboard.press(args.key)
      } else if (action === 'scroll') {
        if (!['up', 'down'].includes(args.direction)) throw new BrowserError('INVALID_ARGUMENT', 'direction must be up or down')
        await page.mouse.move(640, 360)
        await page.mouse.wheel(0, args.direction === 'up' ? -500 : 500)
      } else throw new BrowserError('UNKNOWN_ACTION', `Unsupported action: ${action}`)
    }
    return this.observe()
  }

  async run(action, args = {}, { signal } = {}) {
    if (action === 'close') { await this.shutdown(); return { ok: true, closed: true, trace_path: this.tracePath } }
    if (this.busy || this.closing) return { ok: false, error_code: 'BUSY', message: 'One browser action is already running; wait for its result.' }
    if (this.stopped) return { ok: false, error_code: 'SESSION_CLOSED', message: 'Session closed. Open a new session.' }
    if (signal?.aborted) return { ok: false, error_code: 'ABORTED', message: 'Cancelled before execution.' }
    if (this.steps >= this.config.maxSteps) return { ok: false, error_code: 'STEP_LIMIT', message: 'Step limit reached. Close the session before starting a new task.' }
    this.busy = true
    this.steps++
    clearTimeout(this.idleTimer)
    const controller = new AbortController()
    this.activeSignal = controller.signal
    let abortCleanup
    const cancel = () => { controller.abort(); abortCleanup ??= this.shutdown() }
    signal?.addEventListener('abort', cancel, { once: true })
    const startupBudget = !this.browser && ['open','tab_new'].includes(action) ? this.config.startupTimeoutMs : 0
    const deadline = setTimeout(cancel, startupBudget + this.config.timeoutMs + 1000)
    const started = Date.now()
    try {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new BrowserError('INVALID_ARGUMENT', 'Arguments must be an object.')
      if (['open', 'tab_new'].includes(action) && typeof args.url !== 'string') throw new BrowserError('INVALID_ARGUMENT', 'url must be a string')
      if (['tab_switch','tab_close'].includes(action) && typeof args.tab_id !== 'string') throw new BrowserError('INVALID_ARGUMENT', 'tab_id must be an issued tab ID')
      if (action === 'history' && !['back','forward','reload'].includes(args.direction)) throw new BrowserError('INVALID_ARGUMENT','direction must be back, forward or reload')
      if (['click', 'fill'].includes(action) && typeof args.target !== 'string') throw new BrowserError('INVALID_ARGUMENT', 'target must be an observed accessibility ref')
      if (action === 'fill' && (typeof args.text !== 'string' || args.text.length > 10000)) throw new BrowserError('INVALID_ARGUMENT', 'text must be a string of at most 10000 characters')
      if (['hover', 'check', 'select'].includes(action) && typeof args.target !== 'string') throw new BrowserError('INVALID_ARGUMENT', 'target must be an observed ref')
      if (action === 'check' && typeof args.checked !== 'boolean') throw new BrowserError('INVALID_ARGUMENT', 'checked must be a boolean')
      if (action === 'select' && (!Array.isArray(args.values) || !args.values.length || args.values.length > 50 || args.values.some(v => typeof v !== 'string'))) throw new BrowserError('INVALID_ARGUMENT', 'values must be a nonempty array of up to 50 option values or labels')
      if (action === 'wait' && args.timeout_ms !== undefined && (!Number.isSafeInteger(args.timeout_ms) || args.timeout_ms < 1)) throw new BrowserError('INVALID_ARGUMENT', 'timeout_ms must be a positive integer')
      if (action === 'wait') {
        if ([args.target!==undefined,args.text!==undefined,args.load_state!==undefined,args.tab_count!==undefined].filter(Boolean).length!==1) throw new BrowserError('INVALID_ARGUMENT','Choose exactly one wait condition: target, text, load_state, or tab_count.')
        if(args.tab_count!==undefined&&(!Number.isSafeInteger(args.tab_count)||args.tab_count<1||args.tab_count>this.config.maxTabs))throw new BrowserError('INVALID_ARGUMENT','tab_count must be 1..maxTabs.')
        if (args.load_state!==undefined&&!['domcontentloaded','load'].includes(args.load_state)) throw new BrowserError('INVALID_ARGUMENT','load_state must be domcontentloaded or load; networkidle is not a readiness condition.')
        if (args.state!==undefined&&(!args.target||!['visible','hidden','stable','enabled','disabled','editable'].includes(args.state))) throw new BrowserError('INVALID_ARGUMENT','state requires target and a supported element state.')
      }
      if (action === 'pixel_click' && (typeof args.screenshot_id !== 'string' || ![args.x,args.y].every(Number.isFinite))) throw new BrowserError('INVALID_ARGUMENT', 'pixel_click requires screenshot_id and finite x/y coordinates')
      if (action === 'upload' && (typeof args.chooser_id !== 'string' || !Array.isArray(args.files) || !args.files.length || args.files.length > this.config.maxUploadFiles || args.files.some(p => typeof p !== 'string'))) throw new BrowserError('INVALID_ARGUMENT', 'upload requires an issued chooser_id and 1..maxUploadFiles absolute file paths')
      if (!['observe', 'find', 'tabs', 'screenshot', 'wait', 'pixel_click'].includes(action)) this.visual?.invalidate()
      // Never record filled text or key values in action arguments.
      await this.log({ type: 'action', action, step: this.steps, tab_id: this.tabs.activeId || null, target: args.target ?? null })
      const value = await this.perform(action, args)
      controller.signal.throwIfAborted()
      if (this.guardError) throw new BrowserError('NETWORK_GUARD_LOST', 'Browser closed because its request guard failed.')
      const result = { ok: true, step: this.steps, trace_path: this.tracePath, ...value }
      await this.log({ type: 'result', action, ok: true, elapsed_ms: Date.now() - started })
      return result
    } catch (error) {
      if (controller.signal.aborted) await abortCleanup
      let code = this.guardError ? 'NETWORK_GUARD_LOST' : error.code || (error.name === 'TimeoutError' ? 'ACTION_TIMEOUT' : 'DRIVER_ERROR')
      if (controller.signal.aborted) code = signal?.aborted ? 'ABORTED' : 'CALL_TIMEOUT'
      const uncertain = ['click', 'pixel_click', 'fill', 'press', 'select', 'check', 'upload'].includes(action) && ['ACTION_TIMEOUT', 'CALL_TIMEOUT', 'ABORTED', 'DRIVER_ERROR', 'PAGE_CHANGED'].includes(code)
      // Playwright error call logs may quote fill(text), even though our own
      // action log omits it. Remove that argument before returning or recording.
      let message = `${this.guardError?.message || error.message || 'Operation failed'}`
      if (action === 'upload' && ['ACTION_TIMEOUT', 'CALL_TIMEOUT', 'ABORTED', 'DRIVER_ERROR'].includes(code)) message = 'File selection did not complete reliably. Inspect page/server state before choosing files again. Local file data was not included in this error.'
      if (action === 'fill' && typeof args?.text === 'string' && args.text) message = message.replaceAll(args.text, '[filled text redacted]')
      const result = { ok: false, error_code: code, message: message.slice(0, 1500),
        state_uncertain: uncertain, recovery: uncertain ? 'Do not repeat the action automatically. Observe or reopen the page and inspect whether it already took effect.' : 'Read the error and refresh the observation when appropriate.', trace_path: this.tracePath }
      if (this.page && !this.page.isClosed() && !controller.signal.aborted) {
        try { result.observation = await this.observe() } catch { /* Preserve the original error. */ }
      }
      await this.log({ type: 'result', action, ...result, elapsed_ms: Date.now() - started })
      return result
    } finally {
      clearTimeout(deadline)
      signal?.removeEventListener('abort', cancel)
      if (abortCleanup) await abortCleanup
      this.busy = false
      this.activeSignal = undefined
      if (!this.stopped) {
        this.idleTimer = setTimeout(() => {
          void this.shutdown().catch(error => this.log({ type: 'cleanup_error', message: error.message }).catch(() => {}))
        }, this.config.idleMs)
        this.idleTimer.unref()
      }
    }
  }

  async shutdown() {
    if (this.closePromise) return this.closePromise
    this.stopped = true
    this.closing = true
    clearTimeout(this.idleTimer)
    this.closePromise = (async () => {
      // Closing the browser interrupts pending Playwright waits and inputs.
      const browser = this.browser
      this.guard?.beginClose()
      try { if (browser) await browser.close() }
      finally {
        this.guard?.dispose()
        await this.proxy?.dispose()
        await this.tabs.dispose()
        await this.uploads.dispose()
        this.context = undefined
        this.browser = undefined
      }
    })()
    try { await this.closePromise } finally { this.closing = false }
  }
}
