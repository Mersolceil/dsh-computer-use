import { open, realpath, lstat, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, relative, isAbsolute, basename, extname, sep } from 'node:path'
import { createHash } from 'node:crypto'

function inside(root, path) {
  const tail = relative(root, path)
  return tail !== '' && tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail)
}
const MIME = { '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }

// Browser requests never choose a local path. The caller explicitly supplies
// files, and only this module reads them. Chromium receives bounded byte
// snapshots rather than paths it could reopen later.
export class BrowserUploads {
  constructor(session) {
    this.session = session
    this.choosers = new Map()
    this.sequence = 0
    this.jobs = new Set()
    this.closed = false
  }

  error(code, message) { return this.session.error(code, message) }
  track(job) {
    this.jobs.add(job)
    void job.catch(() => {}).finally(() => this.jobs.delete(job))
  }

  async initialize() {
    this.initialized ??= (async () => {
      const roots = []
      for (const declared of this.session.config.uploadRoots) {
        try {
          const path = await realpath(declared), info = await stat(path)
          if (!info.isDirectory()) throw Error('Not a directory')
          roots.push({ declared: resolve(declared), path, dev: info.dev, ino: info.ino })
        } catch { throw this.error('UPLOAD_ROOT_UNAVAILABLE', 'An uploadRoots directory is unavailable. Configure existing dedicated directories.') }
      }
      this.roots = roots
    })()
    return this.initialized
  }

  capture(tab, chooser) {
    if (this.closed || tab.page.isClosed()) { this.track(chooser.element().dispose()); return }
    this.invalidateTab(tab.id)
    const record = { id: `fc_${this.session.traceId.slice(0, 8)}_${++this.sequence}`, tab, epoch: tab.ax.epoch, chooser }
    this.choosers.set(record.id, record)
  }

  invalidateTab(tabId) {
    for (const [id, record] of this.choosers) if (record.tab.id === tabId) {
      this.choosers.delete(id)
      this.track(record.chooser.element().dispose())
    }
  }

  summary() {
    return {
      upload_policy: { enabled: this.session.config.uploadRoots.length > 0,
        max_files: this.session.config.maxUploadFiles, max_total_bytes: this.session.config.maxUploadBytes },
      file_choosers: [...this.choosers.values()].filter(r => r.epoch === r.tab.ax.epoch && !r.tab.page.isClosed()).map(r => ({
        chooser_id: r.id, tab_id: r.tab.id, multiple: r.chooser.isMultiple(),
      })),
    }
  }

  async record(id) {
    const record = this.choosers.get(id)
    if (!record || record.epoch !== record.tab.ax.epoch || record.tab.page.isClosed()) throw this.error('STALE_CHOOSER', 'This file chooser expired or was already used. Inspect the page before opening a new chooser; do not repeat a submission.')
    if (record.tab !== this.session.tabs.active) throw this.error('WRONG_TAB', 'Select the file chooser tab before uploading.')
    await this.session.tabs.check(record.tab)
    const input = record.chooser.element()
    if (!record.tab.ax.frameAllowed(await input.ownerFrame())) throw this.error('ORIGIN_DENIED', 'File input frame is outside allowed origins.')
    const valid = await input.evaluate(el => ({ connected: el.isConnected && el.tagName === 'INPUT' && el.type === 'file', directory: el.webkitdirectory, disabled: el.disabled })).catch(() => ({}))
    if (!valid.connected) throw this.error('STALE_CHOOSER', 'The original file input was removed or changed. Inspect the page again.')
    if (valid.directory) throw this.error('DIRECTORY_UPLOAD_UNSUPPORTED', 'Directory uploads are not supported. Select individual regular files through a file input.')
    if (valid.disabled) throw this.error('TARGET_DISABLED', 'File input is disabled. No file was selected.')
    return record
  }

  async snapshot(path, remaining) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw this.error('INVALID_ARGUMENT', 'files must contain absolute local file paths.')
    const candidate = resolve(path)
    let file
    try {
      // Freeze root identity at browser startup. Replacing a configured root
      // must not silently authorize a different directory.
      const root = this.roots.find(r => inside(r.declared, candidate) || inside(r.path, candidate))
      if (!root) throw this.error('FILE_ACCESS_DENIED', 'File is outside configured uploadRoots.')
      const rootInfo = await stat(root.path)
      if (rootInfo.dev !== root.dev || rootInfo.ino !== root.ino || await realpath(root.declared) !== root.path) throw this.error('FILE_ACCESS_DENIED', 'Upload root changed after browser startup.')
      const base = inside(root.declared, candidate) ? root.declared : root.path
      const parts = relative(base, candidate).split(sep)
      let current = base
      for (const part of parts) {
        current = resolve(current, part)
        if ((await lstat(current)).isSymbolicLink()) throw this.error('FILE_ACCESS_DENIED', 'Symlinks below uploadRoots are not accepted.')
      }
      const canonical = await realpath(candidate)
      if (!inside(root.path, canonical)) throw this.error('FILE_ACCESS_DENIED', 'Resolved file is outside uploadRoots.')
      file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await file.stat()
      if (!before.isFile()) throw this.error('FILE_TYPE_UNSUPPORTED', 'Only individual regular files can be uploaded.')
      if (before.size > remaining) throw this.error('UPLOAD_TOO_LARGE', 'Combined file bytes exceed maxUploadBytes. Nothing was selected in the page.')
      const identity = await stat(canonical)
      if (identity.dev !== before.dev || identity.ino !== before.ino || await realpath(candidate) !== canonical) throw this.error('FILE_CHANGED', 'File changed while being opened. Nothing was selected in the page.')
      // A fixed allocation and positional reads prevent a concurrently growing
      // file from causing an unbounded readFile allocation.
      const buffer = Buffer.alloc(before.size + 1)
      let size = 0
      while (size < buffer.length) {
        this.session.activeSignal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
        if (!bytesRead) break
        size += bytesRead
      }
      const after = await file.stat()
      if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw this.error('FILE_CHANGED', 'File changed during its snapshot. Nothing was selected in the page.')
      const bytes = buffer.subarray(0, size), name = basename(candidate)
      return { canonical, payload: { name, mimeType: MIME[extname(name).toLowerCase()] || 'application/octet-stream', buffer: bytes },
        metadata: { name, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') } }
    } catch (error) {
      if (error.code && ['FILE_ACCESS_DENIED','FILE_TYPE_UNSUPPORTED','UPLOAD_TOO_LARGE','FILE_CHANGED'].includes(error.code)) throw error
      if (this.session.activeSignal?.aborted) throw error
      throw this.error('FILE_ACCESS_DENIED', 'File could not be read as an allowed regular file. No local path or contents were returned.')
    } finally { await file?.close() }
  }

  async upload({ chooser_id, files }) {
    if (!this.session.config.uploadRoots.length) throw this.error('UPLOAD_DISABLED', 'Uploads are disabled. Configure dedicated uploadRoots before starting a browser session.')
    await this.initialize()
    let record = await this.record(chooser_id)
    if (files.length > 1 && !record.chooser.isMultiple()) throw this.error('UPLOAD_MULTIPLE_DENIED', 'This input accepts one file. No file was selected.')
    const snapshots = [], paths = new Set()
    let remaining = this.session.config.maxUploadBytes
    for (const path of files) {
      const snapshot = await this.snapshot(path, remaining)
      if (paths.has(snapshot.canonical)) throw this.error('INVALID_ARGUMENT', 'Duplicate files are not accepted.')
      paths.add(snapshot.canonical)
      snapshots.push(snapshot)
      remaining -= snapshot.metadata.bytes
    }
    // Path reads may take time. Recheck the exact original input and page,
    // then consume the chooser before a possibly consequential change event.
    this.session.activeSignal?.throwIfAborted()
    record = await this.record(chooser_id)
    this.choosers.delete(chooser_id)
    try {
      await record.chooser.setFiles(snapshots.map(s => s.payload), { timeout: this.session.config.timeoutMs })
      return { chooser_id, files_selected: snapshots.map(s => s.metadata),
        upload_state: 'Files selected in the original input. Page change handlers may submit automatically; inspect actual page/server state before repeating.' }
    } finally { await record.chooser.element().dispose().catch(() => {}) }
  }

  async dispose() {
    this.closed = true
    for (const record of [...this.choosers.values()]) this.invalidateTab(record.tab.id)
    await Promise.allSettled([...this.jobs])
  }
}
