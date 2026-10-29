import { randomUUID } from 'node:crypto'

// A coordinate is meaningful only in the image that supplied it. This guard is
// deliberately conservative: document, layout mutation, frame, scroll, viewport,
// intervening action or timeout changes require another screenshot.
export class VisualReader {
  constructor(session) { this.session = session }
  invalidate() { this.last = undefined }

  async state() {
    const { page, ax } = this.session
    const epoch = ax.epoch
    const frames = []
    for (const frame of page.frames()) {
      if (!ax.frameAllowed(frame)) continue
      frames.push({ frame, value: await frame.evaluate(() => ({ revision: window.__cuRevision,
        x: scrollX, y: scrollY, width: innerWidth, height: innerHeight })) })
    }
    if (epoch !== ax.epoch) throw this.session.error('PAGE_CHANGED', 'A frame navigated while reading the visual state.')
    return { tab_id: this.session.tabId, epoch, url: page.url(), viewport: page.viewportSize(), frames }
  }

  same(a, b) {
    return a.tab_id === b.tab_id && a.epoch === b.epoch && a.url === b.url && JSON.stringify(a.viewport) === JSON.stringify(b.viewport) &&
      a.frames.length === b.frames.length && a.frames.every((record, i) => record.frame === b.frames[i].frame && JSON.stringify(record.value) === JSON.stringify(b.frames[i].value))
  }

  async capture() {
    this.invalidate()
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.state()
      // Hiding carets temporarily edits input styles and would trip our own
      // mutation guard. Preserve them instead of weakening the page guard.
      const bytes = await this.session.page.screenshot({ type: 'png', scale: 'css', caret: 'initial', timeout: this.session.config.timeoutMs })
      const after = await this.state()
      if (!this.same(before, after)) continue
      const id = randomUUID()
      this.last = { id, state: after, created: Date.now() }
      return { screenshot: { mimeType: 'image/png', data: bytes.toString('base64'), ...after.viewport },
        visual_context: { screenshot_id: id, coordinate_space: 'viewport CSS pixels; origin at image top-left', ...after.viewport,
          tab_id: after.tab_id, url: after.url, navigation_epoch: after.epoch,
          valid_for_ms: 60000, requires_fresh_screenshot_after: 'Click, fill, keyboard, hover, select/check, document/frame change, DOM mutation, scrolling, viewport change or a newer screenshot.',
          limitation: 'DOM/layout guards do not detect every paint-only change such as canvas animation. Inspect the actual image and resulting page state.' } }
    }
    throw this.session.error('SCREENSHOT_UNSTABLE', 'Page changed throughout screenshot capture. Wait for a concrete ready condition before trying again.')
  }

  async click({ screenshot_id, x, y }) {
    const issued = this.last
    this.invalidate() // Each image authorizes at most one coordinate attempt.
    if (!issued || screenshot_id !== issued.id || Date.now() - issued.created > 60000) throw this.session.error('STALE_SCREENSHOT', 'Use the screenshot_id from a fresh image. Coordinates cannot be reused after an action.')
    const current = await this.state()
    if (!this.same(issued.state, current)) throw this.session.error('STALE_SCREENSHOT', 'The document, frame, layout or viewport changed. Take a new screenshot before clicking.')
    if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= current.viewport.width || y >= current.viewport.height) throw this.session.error('INVALID_COORDINATE', 'Coordinates must be inside the issued image in CSS pixels.')
    await this.session.page.mouse.click(x, y)
  }
}
