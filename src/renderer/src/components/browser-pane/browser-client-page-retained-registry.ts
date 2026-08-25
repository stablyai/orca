import {
  BrowserClientPageRendererIdentity,
  type BrowserClientPageRendererIdentity as RendererPageIdentity
} from '../../../../shared/browser-client-page-renderer-protocol'
import {
  createBrowserClientPageRetainedHost,
  createBrowserClientPageRetainedRoot,
  createBrowserClientPageWebview,
  hasBrowserClientPageAttachedGuest,
  readBrowserClientPageAttachedGuestId
} from './browser-client-page-retained-elements'
import { browserClientPageRetainedKey } from './browser-client-page-retained-key'
import { rekeyBrowserClientRetainedPage } from './browser-client-page-retained-rekey'
import type { BrowserClientRetainedRendererPage as RetainedPage } from './browser-client-page-retained-state'
import {
  attachBrowserClientRetainedPage,
  enrolRetainedHostDragPassthrough,
  type BrowserClientPageVisibleAttachment
} from './browser-client-page-visible-attachment'
import {
  snapshotBrowserClientPageRendererMemoryProfile,
  type BrowserClientPageRendererMemoryProfile
} from './browser-client-page-retained-memory-profile'

export type { BrowserClientPageVisibleAttachment } from './browser-client-page-visible-attachment'
export type { BrowserClientPageRendererMemoryProfile } from './browser-client-page-retained-memory-profile'

const DEFAULT_MAX_PAGES = 256
const DEFAULT_MAX_PAGES_PER_PARTITION = 64
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000

export class BrowserClientPageRetainedRegistry {
  private readonly maxPages: number
  private readonly maxPagesPerPartition: number
  private readonly attachTimeoutMs: number
  private readonly pages = new Map<string, RetainedPage>()
  private readonly partitionCounts = new Map<string, number>()
  private root: HTMLDivElement | null = null
  private disposed = false

  constructor(
    private readonly options: {
      document: Document
      createWebview?: () => Electron.WebviewTag
      maxPages?: number
      maxPagesPerPartition?: number
      attachTimeoutMs?: number
    }
  ) {
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
    this.maxPagesPerPartition = options.maxPagesPerPartition ?? DEFAULT_MAX_PAGES_PER_PARTITION
    this.attachTimeoutMs = options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
    if (
      !Number.isInteger(this.maxPages) ||
      this.maxPages < 1 ||
      !Number.isInteger(this.maxPagesPerPartition) ||
      this.maxPagesPerPartition < 1 ||
      this.maxPagesPerPartition > this.maxPages ||
      !Number.isFinite(this.attachTimeoutMs) ||
      this.attachTimeoutMs <= 0
    ) {
      throw new Error('browser_client_page_renderer_registry_limits_invalid')
    }
  }

  mountPage(candidate: RendererPageIdentity): Promise<{ webContentsId: number }> {
    let identity: RendererPageIdentity
    try {
      identity = BrowserClientPageRendererIdentity.parse(candidate)
    } catch {
      return Promise.reject(new Error('browser_client_page_renderer_identity_invalid'))
    }
    if (this.disposed) {
      return Promise.reject(new Error('browser_client_page_renderer_registry_disposed'))
    }
    const key = browserClientPageRetainedKey(identity)
    const existing = this.pages.get(key)
    if (existing) {
      if (existing.status === 'attaching') {
        return existing.mount
      }
      if (existing.status === 'attached' && existing.webContentsId !== null) {
        if (readBrowserClientPageAttachedGuestId(existing.webview) !== existing.webContentsId) {
          this.fenceRendererLoss(existing)
          return Promise.reject(new Error('browser_client_page_renderer_process_gone'))
        }
        return Promise.resolve({ webContentsId: existing.webContentsId })
      }
      return Promise.reject(new Error('browser_client_page_renderer_page_retiring'))
    }
    if (this.pages.size >= this.maxPages) {
      return Promise.reject(new Error('browser_client_page_renderer_capacity'))
    }
    if ((this.partitionCounts.get(identity.partition) ?? 0) >= this.maxPagesPerPartition) {
      return Promise.reject(new Error('browser_client_page_renderer_partition_capacity'))
    }
    return this.createPage(identity, key).mount
  }

  attachPage(
    identity: Pick<RendererPageIdentity, 'browserPageId' | 'pageHostGeneration'>,
    container: HTMLElement
  ): BrowserClientPageVisibleAttachment {
    const page = [...this.pages.values()].find(
      (candidate) =>
        candidate.identity.browserPageId === identity.browserPageId &&
        candidate.identity.pageHostGeneration === identity.pageHostGeneration
    )
    return attachBrowserClientRetainedPage(page, this.pages, container)
  }

  retirePage(candidate: RendererPageIdentity): void {
    const parsed = BrowserClientPageRendererIdentity.safeParse(candidate)
    if (!parsed.success) {
      throw new Error('browser_client_page_renderer_identity_invalid')
    }
    const page = this.pages.get(browserClientPageRetainedKey(parsed.data))
    if (!page || page.status === 'retiring') {
      return
    }
    const wasAttaching = page.status === 'attaching'
    page.status = 'retiring'
    clearTimeout(page.attachTimer)
    if (wasAttaching) {
      page.rejectMount(new Error('browser_client_page_renderer_page_retired'))
    }
    this.disconnectPage(page)
    if (
      wasAttaching &&
      !page.attachmentObserved &&
      !hasBrowserClientPageAttachedGuest(page.webview)
    ) {
      this.releasePage(page)
    }
  }

  rekeyPage(previousCandidate: RendererPageIdentity, nextCandidate: RendererPageIdentity): void {
    rekeyBrowserClientRetainedPage(this.pages, previousCandidate, nextCandidate, (page) =>
      this.fenceRendererLoss(page)
    )
  }

  getMemoryProfile(): BrowserClientPageRendererMemoryProfile {
    return snapshotBrowserClientPageRendererMemoryProfile(this.pages, this.partitionCounts.size)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const page of this.pages.values()) {
      if (page.status === 'attaching') {
        page.rejectMount(new Error('browser_client_page_renderer_registry_disposed'))
      }
      page.host.remove()
      this.releasePage(page)
    }
    this.root?.remove()
    this.root = null
  }

  private createPage(identity: RendererPageIdentity, key: string): RetainedPage {
    const host = createBrowserClientPageRetainedHost(this.options.document, identity.browserPageId)
    const webview = createBrowserClientPageWebview({
      createWebview: this.options.createWebview,
      document: this.options.document,
      partition: identity.partition
    })

    let resolveMount!: RetainedPage['resolveMount']
    let rejectMount!: RetainedPage['rejectMount']
    const mount = new Promise<{ webContentsId: number }>((resolve, reject) => {
      resolveMount = resolve
      rejectMount = reject
    })
    const page = {} as RetainedPage
    const onAttached = (): void => this.observeAttachment(page)
    const onReady = (): void => this.finishAttachment(page)
    const onDestroyed = (): void => this.handleDestroyed(page)
    const onRendererGone = (): void => this.fenceRendererLoss(page)
    Object.assign(page, {
      key,
      identity,
      host,
      webview,
      status: 'attaching',
      webContentsId: null,
      metadataRevision: 0,
      attachmentObserved: false,
      visibleAttachment: null,
      mount,
      resolveMount,
      rejectMount,
      attachTimer: setTimeout(
        () => this.failAttachment(page, 'browser_client_page_renderer_attach_timeout'),
        this.attachTimeoutMs
      ),
      onAttached,
      onReady,
      onDestroyed,
      onRendererGone
    })
    page.releaseDragPassthroughSurface = enrolRetainedHostDragPassthrough(page)
    webview.addEventListener('did-attach', onAttached)
    webview.addEventListener('dom-ready', onReady)
    webview.addEventListener('destroyed', onDestroyed)
    webview.addEventListener('render-process-gone', onRendererGone)
    this.pages.set(key, page)
    this.partitionCounts.set(
      identity.partition,
      (this.partitionCounts.get(identity.partition) ?? 0) + 1
    )
    host.appendChild(webview)
    this.ensureRoot().appendChild(host)
    return page
  }

  private observeAttachment(page: RetainedPage): void {
    if (this.pages.get(page.key) !== page || page.status !== 'attaching') {
      return
    }
    page.attachmentObserved = true
    this.finishAttachment(page)
  }

  private finishAttachment(page: RetainedPage): void {
    if (this.pages.get(page.key) !== page || page.status !== 'attaching') {
      return
    }
    let webContentsId: number
    try {
      webContentsId = page.webview.getWebContentsId()
    } catch {
      return
    }
    if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
      return
    }
    clearTimeout(page.attachTimer)
    page.status = 'attached'
    page.webContentsId = webContentsId
    page.resolveMount({ webContentsId })
  }

  private failAttachment(page: RetainedPage, errorCode: string): void {
    if (this.pages.get(page.key) !== page || page.status !== 'attaching') {
      return
    }
    page.status = 'retiring'
    clearTimeout(page.attachTimer)
    page.rejectMount(new Error(errorCode))
    this.disconnectPage(page)
    if (!page.attachmentObserved && !hasBrowserClientPageAttachedGuest(page.webview)) {
      this.releasePage(page)
    }
  }

  private fenceRendererLoss(page: RetainedPage): void {
    if (this.pages.get(page.key) !== page || page.status === 'retiring') {
      return
    }
    if (page.status === 'attaching') {
      page.rejectMount(new Error('browser_client_page_renderer_process_gone'))
    }
    page.status = 'retiring'
    clearTimeout(page.attachTimer)
    this.disconnectPage(page)
  }

  private handleDestroyed(page: RetainedPage): void {
    if (this.pages.get(page.key) !== page) {
      return
    }
    if (page.status === 'attaching') {
      page.rejectMount(new Error('browser_client_page_renderer_guest_destroyed'))
    }
    this.releasePage(page)
  }

  private releasePage(page: RetainedPage): void {
    if (this.pages.get(page.key) !== page) {
      return
    }
    clearTimeout(page.attachTimer)
    page.releaseDragPassthroughSurface()
    page.webview.removeEventListener('did-attach', page.onAttached)
    page.webview.removeEventListener('dom-ready', page.onReady)
    page.webview.removeEventListener('destroyed', page.onDestroyed)
    page.webview.removeEventListener('render-process-gone', page.onRendererGone)
    page.visibleAttachment = null
    page.webview.remove()
    page.host.remove()
    this.pages.delete(page.key)
    const nextCount = (this.partitionCounts.get(page.identity.partition) ?? 1) - 1
    if (nextCount > 0) {
      this.partitionCounts.set(page.identity.partition, nextCount)
    } else {
      this.partitionCounts.delete(page.identity.partition)
    }
  }

  private ensureRoot(): HTMLDivElement {
    if (this.root) {
      return this.root
    }
    const root = createBrowserClientPageRetainedRoot(this.options.document)
    this.root = root
    return root
  }

  private disconnectPage(page: RetainedPage): void {
    page.visibleAttachment = null
    page.webview.remove()
    page.host.remove()
  }
}
