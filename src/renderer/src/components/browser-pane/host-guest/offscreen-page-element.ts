import type {
  OffscreenPageCommand,
  OffscreenPageGuestEvent,
  OffscreenPageGuestState
} from '../../../../../shared/offscreen-page-protocol'
import { OFFSCREEN_PAGE_TAG } from './browser-page-guest-element-kind'
import { dispatchBrowserPageZoomEvent } from './browser-page-zoom'
import { bindOffscreenPageInputSurface } from './offscreen-page-input-surface'
import {
  OFFSCREEN_PAGE_DATALIST_STYLE,
  renderOffscreenPageDatalist
} from './offscreen-page-datalist-overlay'

const EMPTY_STATE: OffscreenPageGuestState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  zoomLevel: 0
}

/**
 * A <webview> stand-in whose page lives offscreen in main and paints into a canvas here. It keeps
 * the slice of the webview interface the browser pane uses, so the pane cannot tell the two apart;
 * what changes is that no input to the page, agent or user, can move this window's focus.
 */
export class OrcaOffscreenPageElement extends HTMLElement {
  private readonly canvas = document.createElement('canvas')
  private readonly ime = document.createElement('textarea')
  private readonly datalist = document.createElement('div')
  private state: OffscreenPageGuestState = EMPTY_STATE
  private webContentsId: number | null = null
  private domReady = false
  /** Main destroyed the page under a live element; only a replacement element brings it back. */
  private gone = false
  private creating = false
  private pendingSrc: string | null = null
  private nextFindRequestId = 1
  private unbindInput: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  // Why 1280x800: matches the headless backend's default page size for a tab never shown yet.
  private lastVisibleSize = { width: 1280, height: 800 }
  private lastPointer = { x: 0, y: 0 }

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host { display: block; position: relative; overflow: hidden; }
      canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      textarea { position: absolute; left: 0; top: 0; width: 1px; height: 16px; padding: 0;
        border: 0; margin: 0; opacity: 0; resize: none; overflow: hidden; pointer-events: none; }
      ${OFFSCREEN_PAGE_DATALIST_STYLE}`
    this.ime.setAttribute('aria-hidden', 'true')
    this.ime.tabIndex = -1
    this.datalist.className = 'datalist'
    this.datalist.hidden = true
    root.append(style, this.canvas, this.ime, this.datalist)
    this.canvas.addEventListener('mousemove', (event) => {
      this.lastPointer = { x: event.clientX, y: event.clientY }
    })
  }

  get browserPageId(): string {
    return this.dataset.browserPageId ?? ''
  }

  connectedCallback(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer)
      this.closeTimer = null
    }
    this.resizeObserver ??= new ResizeObserver(() => this.syncViewport())
    this.resizeObserver.observe(this)
    this.unbindInput ??= bindOffscreenPageInputSurface(this.canvas, this.ime, {
      input: (input) => window.api.offscreenPage.input(this.browserPageId, input),
      edit: (action) => this.command({ kind: 'edit', action }),
      focusPage: () => window.api.offscreenPage.focus(this.browserPageId),
      setKeyboardFocus: (focused) =>
        window.api.offscreenPage.setKeyboardFocus(this.browserPageId, focused),
      zoom: (direction) =>
        dispatchBrowserPageZoomEvent({ browserPageId: this.browserPageId, direction }),
      readCaret: () => window.api.offscreenPage.readCaret(this.browserPageId)
    })
  }

  disconnectedCallback(): void {
    this.resizeObserver?.disconnect()
    // Why deferred: a same-task re-append is a move, not a teardown.
    this.closeTimer = setTimeout(() => {
      if (!this.isConnected) {
        this.unbindInput?.()
        this.unbindInput = null
        window.api.offscreenPage.close(this.browserPageId)
      }
    }, 0)
  }

  // ── webview-compatible surface ──

  get src(): string {
    return this.state.url || this.getAttribute('src') || ''
  }

  set src(url: string) {
    this.setAttribute('src', url)
    if (this.webContentsId === null) {
      this.pendingSrc = url
      void this.createPage()
    } else {
      this.command({ kind: 'loadURL', url })
    }
  }

  loadURL(url: string): Promise<void> {
    this.src = url
    return Promise.resolve()
  }

  getWebContentsId(): number {
    if (this.webContentsId === null) {
      throw new Error('The offscreen page has not been attached yet.')
    }
    return this.webContentsId
  }

  getURL(): string {
    if (!this.domReady) {
      throw new Error('The offscreen page is not ready yet.')
    }
    return this.state.url
  }

  getTitle(): string {
    return this.state.title
  }

  canGoBack(): boolean {
    return this.state.canGoBack
  }

  canGoForward(): boolean {
    return this.state.canGoForward
  }

  isLoading(): boolean {
    return this.state.isLoading
  }

  getZoomLevel(): number {
    return this.state.zoomLevel
  }

  setZoomLevel(level: number): void {
    this.state = { ...this.state, zoomLevel: level }
    this.command({ kind: 'setZoomLevel', level })
  }

  goBack(): void {
    this.command({ kind: 'goBack' })
  }

  goForward(): void {
    this.command({ kind: 'goForward' })
  }

  reload(): void {
    this.command({ kind: 'reload' })
  }

  reloadIgnoringCache(): void {
    this.command({ kind: 'reloadIgnoringCache' })
  }

  stop(): void {
    this.command({ kind: 'stop' })
  }

  findInPage(
    text: string,
    options: { forward?: boolean; findNext?: boolean; matchCase?: boolean } = {}
  ): number {
    this.command({ kind: 'findInPage', text, ...options })
    return this.nextFindRequestId++
  }

  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void {
    this.command({ kind: 'stopFindInPage', action })
  }

  /** Last painted frame; the pane only reads isEmpty, getSize and toDataURL. */
  capturePage(): Promise<{
    isEmpty(): boolean
    getSize(): { width: number; height: number }
    toDataURL(): string
  }> {
    const { width, height } = this.canvas
    const dataUrl = width && height ? this.canvas.toDataURL('image/png') : ''
    return Promise.resolve({
      isEmpty: () => !dataUrl,
      getSize: () => ({ width, height }),
      toDataURL: () => dataUrl
    })
  }

  override focus(options?: FocusOptions): void {
    this.ime.focus({ preventScroll: options?.preventScroll ?? true })
    window.api.offscreenPage.focus(this.browserPageId)
  }

  override blur(): void {
    this.ime.blur()
  }

  isDestroyed(): boolean {
    return this.gone || (!this.isConnected && this.webContentsId === null)
  }

  // ── internals ──

  private command(command: OffscreenPageCommand): void {
    // Why throw: a <webview> whose guest died throws here, which is what sends the pane's recovery
    // to rebuild the guest instead of waiting on a reload that can never land.
    if (this.gone) {
      throw new Error('The offscreen page is gone.')
    }
    if (this.webContentsId !== null) {
      window.api.offscreenPage.command(this.browserPageId, command)
    }
  }

  private viewport() {
    const visible = this.isConnected && this.clientWidth > 0 && this.clientHeight > 0
    if (visible) {
      this.lastVisibleSize = {
        width: Math.round(this.clientWidth),
        height: Math.round(this.clientHeight)
      }
    }
    // Why keep the last size while hidden: agents still drive background tabs, and a collapsed
    // pane must not shrink their page to one pixel.
    return { ...this.lastVisibleSize, visible }
  }

  private syncViewport(): void {
    if (this.webContentsId !== null) {
      window.api.offscreenPage.setViewport(this.browserPageId, this.viewport())
    }
  }

  private async createPage(): Promise<void> {
    if (this.creating || this.pendingSrc === null) {
      return
    }
    this.creating = true
    const src = this.pendingSrc
    window.api.offscreenPage.attach(this.browserPageId, this.canvas, {
      onEvent: (event) => this.onGuestEvent(event),
      onCursor: (cursor) => {
        this.canvas.style.cursor = cursor
      },
      onTooltip: (text) => this.showTooltip(text),
      onDatalist: (datalist) => renderOffscreenPageDatalist(this.datalist, datalist),
      onSelect: (anchor) => {
        // Main needs window coordinates; only this side knows where the element sits.
        const box = this.getBoundingClientRect()
        window.api.offscreenPage.showSelectMenu(this.browserPageId, {
          x: box.left + anchor.x,
          y: box.top + anchor.y
        })
      }
    })
    const webContentsId = await window.api.offscreenPage.create({
      browserPageId: this.browserPageId,
      partition: this.getAttribute('partition') ?? '',
      src,
      viewport: this.viewport()
    })
    this.creating = false
    if (webContentsId === null) {
      this.dispatchGuestEvent('did-fail-load', {
        errorCode: -3,
        errorDescription: 'Offscreen page was refused',
        validatedURL: src,
        isMainFrame: true
      })
      return
    }
    this.webContentsId = webContentsId
    this.pendingSrc = null
    this.dispatchGuestEvent('did-attach', {})
  }

  /** Shows the page's tooltip the way a <webview>'s shows: natively, from the element's title. */
  private showTooltip(text: string): void {
    if (text) {
      this.canvas.title = text
    } else {
      this.canvas.removeAttribute('title')
    }
    // Why: Chromium reads a title only on pointer moves, and this one arrived after the last.
    if (this.canvas.matches(':hover')) {
      window.api.offscreenPage.refreshHover(this.browserPageId, this.lastPointer)
    }
  }

  private onGuestEvent(event: OffscreenPageGuestEvent): void {
    this.state = event.state ?? this.state
    if (event.type === 'state') {
      return
    }
    if (event.type === 'dom-ready') {
      this.domReady = true
    }
    if (event.type === 'destroyed') {
      this.gone = true
    }
    if (event.type === 'render-process-gone' || event.type === 'destroyed') {
      this.domReady = false
    }
    this.dispatchGuestEvent(event.type, event.detail)
  }

  private dispatchGuestEvent(type: string, detail: Record<string, unknown>): void {
    this.dispatchEvent(Object.assign(new Event(type), detail))
  }
}

export function defineOffscreenPageElement(): void {
  if (!customElements.get(OFFSCREEN_PAGE_TAG)) {
    customElements.define(OFFSCREEN_PAGE_TAG, OrcaOffscreenPageElement)
  }
}
