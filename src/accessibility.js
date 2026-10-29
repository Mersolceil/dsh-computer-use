// The observation source is Playwright's official ARIA snapshot engine. It
// computes accessible roles/names/states, traverses open shadow DOM and frames.
// Only fixed, already-observed aria-ref selectors are resolved by this module.
const ACTION_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'treeitem'])
const CONTEXT_ROLES = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'dialog', 'alertdialog', 'heading', 'table', 'grid', 'row', 'cell', 'gridcell', 'rowheader', 'columnheader', 'list', 'tree', 'tablist', 'menu', 'status', 'alert', 'progressbar', 'iframe'])
const STATE_KEYS = ['checked', 'disabled', 'expanded', 'active', 'invalid', 'level', 'pressed', 'selected', 'value', 'valuemin', 'valuemax', 'valuenow', 'valuetext', 'placeholder', 'url']

function copyNode(source) {
  if (typeof source === 'string') return source
  const node = { role: source.role || 'generic' }
  if (source.name) node.name = source.name
  if (source.ref) node.rawRef = source.ref
  if (source.text) node.text = source.text
  if (source.cursor) node.cursor = source.cursor
  for (const key of STATE_KEYS) if (source[key] !== undefined) node[key] = source[key]
  if (source.children) node.children = source.children.map(copyNode)
  return node
}
function flatten(nodes, list = []) {
  for (const node of nodes) if (typeof node !== 'string') { list.push(node); flatten(node.children || [], list) }
  return list
}
// Input values are not a search index: matching a password before rendering it
// would reveal information even if its eventual value were redacted.
const TEXT_ENTRY_ROLES = new Set(['textbox', 'searchbox'])
function searchable(node) { return typeof node === 'string' ? node : [node.name, TEXT_ENTRY_ROLES.has(node.role) ? undefined : node.text, node.role].filter(Boolean).join(' ') }
function project(nodes, { filter, depth, query }, level = 0) {
  return nodes.flatMap(node => {
    if (typeof node === 'string') return filter === 'all' && (!query || node.toLocaleLowerCase().includes(query)) ? [node] : []
    const matches = !query || searchable(node).toLocaleLowerCase().includes(query)
    if (query && TEXT_ENTRY_ROLES.has(node.role) && !matches) return []
    const childFilter = ['status', 'alert', 'cell', 'gridcell', 'rowheader', 'columnheader'].includes(node.role) ? 'all' : filter
    const children = level < depth ? project(node.children || [], { filter: childFilter, depth, query: matches && query ? undefined : query }, level + 1) : []
    const relevant = filter === 'all' || ACTION_ROLES.has(node.role) || CONTEXT_ROLES.has(node.role) || Boolean(node.cursor)
    if ((!matches || !relevant) && !children.length) return []
    const out = { ...node }
    if (query && !matches) delete out.text
    if (children.length) out.children = children
    else delete out.children
    if (level >= depth && node.children?.length) out.omitted_children = true
    return [out]
  })
}
function formatLine(node, indent) {
  if (typeof node === 'string') return `${'  '.repeat(indent)}- text: ${JSON.stringify(node)}`
  let line = `${'  '.repeat(indent)}- ${node.role}${node.name ? ' ' + JSON.stringify(node.name) : ''}`
  if (node.ref) line += ` [ref=${node.ref}]`
  for (const key of STATE_KEYS) if (node[key] !== undefined) line += ` [${key}=${JSON.stringify(node[key])}]`
  if (node.text) line += `: ${JSON.stringify(node.text)}`
  if (node.omitted_children) line += ' [children omitted: increase depth or scope the read]'
  return line
}

export class AccessibilityReader {
  constructor(session) {
    this.session = session
    this.references = new Map()
    this.epoch = 0
    this.raw = []
    this.currentRawRefs = new Set()
  }

  async clear() {
    this.epoch++
    const records = [...this.references.values()]
    this.references.clear()
    this.raw = []
    this.currentRawRefs.clear()
    await Promise.allSettled(records.map(record => record.handle.dispose()))
  }

  frameAllowed(frame) {
    if (!frame) return false
    const url = frame.url()
    if (url === 'about:blank' || url === 'about:srcdoc') return frame.parentFrame() ? this.frameAllowed(frame.parentFrame()) : Boolean(this.session.allowBlankDocument)
    try { this.session.checkUrl(url); return true } catch { return false }
  }

  async capture() {
    const page = this.session.page
    let epoch, raw
    // Observation is safe to retry when a child frame completes navigation
    // during the read. Never repeat the preceding click or submission.
    for (let attempt = 0; attempt < 3; attempt++) {
      epoch = this.epoch
      raw = (await page.ariaSnapshotJSON({ mode: 'ai', timeout: this.session.config.timeoutMs, signal: this.session.activeSignal })).map(copyNode)
      if (this.epoch === epoch) break
      if (attempt === 2) throw this.session.error('PAGE_CHANGED', 'Page kept navigating during observation. Wait for a concrete ready condition and read again.')
    }
    this.raw = raw
    this.currentRawRefs = new Set(flatten(raw).map(node => node.rawRef).filter(Boolean))
    // Retire stale semantics, not just detached elements: Playwright assigns a
    // new raw ref when a node's accessible name or role changes.
    const retired = []
    for (const [ref, record] of this.references) if (!this.currentRawRefs.has(record.rawRef) || record.epoch !== epoch) {
      this.references.delete(ref); retired.push(record.handle.dispose())
    }
    await Promise.allSettled(retired)
    return raw
  }

  async bind(node) {
    if (!node.rawRef) return undefined
    const epoch = this.epoch
    const ref = `${this.session.tabId ? this.session.tabId + ':' : ''}d${epoch}:${node.rawRef}`
    let record = this.references.get(ref)
    if (!record) {
      // Resolve once, without waiting for a vanished node to reappear. A read
      // can be repeated; an action must retain its exact original identity.
      const [handle] = await this.session.page.locator(`aria-ref=${node.rawRef}`).elementHandles()
      if (!handle) throw this.session.error('PAGE_CHANGED', 'An observed node changed while reading. Read the page again.')
      if (!this.frameAllowed(await handle.ownerFrame())) { await handle.dispose(); return undefined }
      if (epoch !== this.epoch) { await handle.dispose(); throw this.session.error('PAGE_CHANGED', 'Document changed while binding an observation.') }
      record = { handle, rawRef: node.rawRef, epoch, role: node.role, name: node.name || '' }
      this.references.set(ref, record)
    }
    // Least recently emitted refs are evicted first; a ref in the current read
    // must not be dropped merely because its DOM node was first seen long ago.
    this.references.delete(ref)
    this.references.set(ref, record)
    // Metadata enriches the official semantic node; it never guesses a name.
    const details = await record.handle.evaluate(el => ({ tag: el.tagName.toLowerCase(), input_type: el.getAttribute('type') || '',
      password: el.tagName === 'INPUT' && el.type === 'password', value: typeof el.value === 'string' ? el.value.slice(0, 300) : '',
      editable: el.isContentEditable, frame_title: el.tagName === 'IFRAME' ? el.title : '' }))
    if (epoch !== this.epoch) throw this.session.error('PAGE_CHANGED', 'Document changed while reading element metadata.')
    return { ref, record, details }
  }

  async resolve(ref, { refresh = true } = {}) {
    this.checkTabRef(ref)
    if (refresh) await this.capture()
    const record = this.references.get(ref)
    if (!record || record.epoch !== this.epoch || !this.currentRawRefs.has(record.rawRef) || !await record.handle.evaluate(el => el.isConnected).catch(() => false)) {
      throw this.session.error('STALE_TARGET', 'Target is no longer present with the observed role/name, or its document navigated. Observe/find again; never guess a replacement.')
    }
    if (!this.frameAllowed(await record.handle.ownerFrame())) throw this.session.error('ORIGIN_DENIED', 'Target frame is outside the allowed origins.')
    if (!await record.handle.isVisible()) throw this.session.error('TARGET_NOT_VISIBLE', 'Target is no longer visible. Observe again.')
    return record.handle
  }

  async waitHandle(ref) {
    this.checkTabRef(ref)
    const record = this.references.get(ref)
    if (!record || record.epoch !== this.epoch) throw this.session.error('STALE_TARGET', 'Wait target belongs to an old document or was never observed.')
    if (!this.frameAllowed(await record.handle.ownerFrame())) throw this.session.error('ORIGIN_DENIED', 'Wait target frame is outside allowed origins.')
    return record.handle
  }

  checkTabRef(ref) {
    if (typeof ref === 'string' && /^t\d+:/.test(ref) && !ref.startsWith(this.session.tabId + ':')) throw this.session.error('WRONG_TAB', 'This reference belongs to another tab. Select its tab_id first; do not use a same-named element on the current page.')
  }

  async read(options = {}) {
    // Retry only a pure observation; never repeat the operation that led here.
    for (let attempt = 0; ; attempt++) {
      try { return await this.readOnce(options) }
      catch (error) {
        if (error.code !== 'PAGE_CHANGED' || attempt >= 2 || this.session.activeSignal?.aborted) throw error
      }
    }
  }

  async readOnce(options = {}) {
    const { config } = this.session
    const filter = options.filter || 'interactive'
    const depth = options.depth ?? config.observationDepth
    const maxChars = options.max_chars ?? config.maxTreeChars
    if (!['all', 'interactive'].includes(filter) || !Number.isSafeInteger(depth) || depth < 1 || depth > 50 || !Number.isSafeInteger(maxChars) || maxChars < 500 || maxChars > config.maxTreeChars) {
      throw this.session.error('INVALID_ARGUMENT', 'filter must be all/interactive; depth 1..50; max_chars 500..configured maxTreeChars.')
    }
    if (options.query !== undefined && (typeof options.query !== 'string' || !options.query.trim() || options.query.length > 200)) throw this.session.error('INVALID_ARGUMENT', 'query must be a nonempty string up to 200 characters')
    await this.capture()
    const epoch = this.epoch
    let source = this.raw
    if (options.target) {
      this.checkTabRef(options.target)
      const record = this.references.get(options.target)
      if (!record) throw this.session.error('STALE_TARGET', 'Scope target is stale. Observe or find again.')
      const node = flatten(source).find(node => node.rawRef === record.rawRef)
      if (!node) throw this.session.error('STALE_TARGET', 'Scope target disappeared.')
      source = [node]
    }
    // Project first so scoped/limited reads do not bind every input on a huge
    // page. Search ignores input values; emitted nodes are redacted below before
    // text derivation or logging. Snapshot JSON contains plaintext passwords.
    const selected = project(source, { filter, depth, query: options.query?.toLocaleLowerCase() })
    const elements = [], lines = [], texts = []
    let chars = 0, truncated = false, visited = 0
    const emit = async (nodes, level = 0) => {
      for (const node of nodes) {
        if (chars >= maxChars || visited >= config.maxObservationNodes) { truncated = true; break }
        visited++
        if (typeof node !== 'string') {
          if (node.omitted_children) truncated = true
          const binding = await this.bind(node)
          if (node.rawRef && !binding) continue
          if (binding) {
            node.ref = binding.ref
            if (binding.details.password) { node.text = '[redacted]'; delete node.value; delete node.children }
            if (node.role === 'iframe') {
              const frame = await binding.record.handle.contentFrame()
              if (!this.frameAllowed(frame)) { node.text = '[frame outside allowed origins]'; delete node.children }
            }
            if (ACTION_ROLES.has(node.role) && elements.length < config.maxElements) {
              elements.push({ ref: binding.ref, role: node.role, name: node.name || '', tag: binding.details.tag,
                input_type: binding.details.input_type, disabled: Boolean(node.disabled), checked: node.checked ?? false,
                value: binding.details.password ? '[redacted]' : binding.details.value, ...(node.selected !== undefined ? { selected: node.selected } : {}) })
            }
          }
          if (node.text) texts.push(node.text)
        } else texts.push(node)
        let line = formatLine(node, level)
        if (chars + line.length + 1 > maxChars) { truncated = true; break }
        lines.push(line); chars += line.length + 1
        if (typeof node !== 'string' && node.children) await emit(node.children, level + 1)
      }
    }
    await emit(selected)
    if (epoch !== this.epoch) throw this.session.error('PAGE_CHANGED', 'Document changed during observation. No mixed-document snapshot was returned.')
    while (this.references.size > config.maxTrackedRefs) {
      const [ref, record] = this.references.entries().next().value
      this.references.delete(ref); await record.handle.dispose()
    }
    return { accessibility_tree: lines.join('\n'), observation_source: 'playwright-aria-snapshot', filter, depth,
      ...(options.target ? { scope: options.target } : {}), ...(options.query ? { query: options.query } : {}),
      text: texts.join('\n').slice(0, config.maxTreeChars), elements, truncated,
      ...(truncated ? { next_read: 'Use cu_browser_find(query) or cu_browser_observe(target, depth, filter) to read the omitted region.' } : {}),
      navigation_epoch: this.epoch, reference_lifetime: 'Stable while the same document node retains its accessible role/name. Navigation, replacement, semantic changes or cache eviction invalidate it.' }
  }
}

// DSH native rendering and the standalone evaluator use the same compact
// observation: the tree is primary; the redundant compatibility index is not
// sent to the model. Canonical JSON still exposes it to programmatic callers.
export function modelObservation(value) {
  if (!value || typeof value !== 'object') return value
  const { elements, text, ...rest } = value
  if (value.observation) rest.observation = modelObservation(value.observation)
  if (!value.accessibility_tree) { if (elements !== undefined) rest.elements = elements; if (text !== undefined) rest.text = text }
  return rest
}
