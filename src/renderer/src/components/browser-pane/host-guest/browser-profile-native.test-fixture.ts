import { vi } from 'vitest'
import {
  DestroyedGuestTestContents,
  DestroyedGuestTestManager
} from '../../../../../main/browser/guest-lifecycle/manager/registration/browser-manager-destroyed-guest-test-fixture'
import {
  admitBrowserPageAttach,
  acknowledgeBrowserPageRemoval,
  associateBrowserPageAttach,
  closeBrowserMemoryPage,
  prepareBrowserPageAttach,
  reserveBrowserPageDiscard,
  startBrowserPageAttach,
  waitForBrowserPageReady
} from '../../../../../main/browser/guest-lifecycle/browser-page-memory'
import { registeredWebContentsIds, webviewRegistry } from './webview-registry'
import { closePersistentBrowserPage } from './browser-webview-disposal'
import { releaseBrowserPageMount } from './browser-page-mount-admission'

export class ProfileTestGuest extends DestroyedGuestTestContents {
  readonly hostWebContents = { id: 99 }
  readonly mainFrame = { frames: [], send: vi.fn() }
  loading = true
  url = 'https://example.test'
  getURL(): string {
    return this.url
  }
  getTitle(): string {
    return 'Retained title'
  }
  private resolveLoad = (): void => {}
  private readonly load = new Promise<void>((resolve) => {
    this.resolveLoad = resolve
  })
  readonly loadURL = vi.fn(() => this.load)
  readonly navigationHistory = {
    getAllEntries: () => [{ url: this.getURL(), title: this.getTitle() }],
    getActiveIndex: () => 0,
    restore: vi.fn((args: { entries: { url: string; title?: string }[]; index: number }) => {
      this.url = args.entries[args.index].url
      return this.load
    })
  }
  isLoading(): boolean {
    return this.loading
  }
  isDevToolsOpened(): boolean {
    return false
  }
  isCrashed(): boolean {
    return false
  }
  finish(): void {
    this.loading = false
    this.emit('did-navigate', {}, this.getURL())
    this.emit('did-finish-load')
    this.emit('did-stop-loading')
    this.resolveLoad()
  }
  close(): void {
    this.destroy()
  }
}

export function installProfileNativeFixture(native: Map<number, Electron.WebContents>) {
  const manager = new DestroyedGuestTestManager()
  const pageIds = new Set<string>()
  const guests = new Map<string, ProfileTestGuest>()
  const creations: string[] = []
  const preparations: { browserPageId: string; partition: string; url: string }[] = []
  const preparedByMarker = new Map<string, { browserPageId: string; url: string }>()
  const unregistrations: {
    browserPageId: string
    webContentsId?: number
    replacement?: boolean
  }[] = []
  const createElement = document.createElement.bind(document)
  let autoFinish = true
  const webviews = new Map<string, Electron.WebviewTag>()
  function finish(guest: ProfileTestGuest, webview: Electron.WebviewTag): void {
    guest.finish()
    webview.dispatchEvent(new Event('dom-ready'))
    webview.dispatchEvent(new Event('did-finish-load'))
    webview.dispatchEvent(new Event('did-stop-loading'))
  }
  let nextId = 1
  function createProfileElement(name: 'webview'): Electron.WebviewTag
  function createProfileElement(name: string, options?: ElementCreationOptions): HTMLElement
  function createProfileElement(name: string, options?: ElementCreationOptions): HTMLElement {
    const element = createElement(name, options)
    if (name !== 'webview') {
      return element
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture installs the webview API used by the production attachment lifecycle.
    const webview = element as Electron.WebviewTag
    let guest: ProfileTestGuest | undefined
    let source = ''
    Object.defineProperty(webview, 'src', {
      configurable: true,
      get: () => source,
      set: (marker: string) => {
        const partition = webview.getAttribute('partition') ?? ''
        admitBrowserPageAttach(marker, 99, partition)
        const prepared = preparedByMarker.get(marker)!
        source = prepared.url
        guest = new ProfileTestGuest(nextId++)
        guest.url = prepared.url
        const current = guest
        native.set(current.id, current.asWebContents())
        associateBrowserPageAttach(current.asWebContents())
        startBrowserPageAttach(current.asWebContents())
        manager.attachGuestPolicies(current.asWebContents())
        const pageId = prepared.browserPageId
        guests.set(pageId, current)
        webviews.set(pageId, webview)
        creations.push(pageId)
        webview.dispatchEvent(new Event('did-attach'))
        if (autoFinish) {
          finish(current, webview)
        }
      }
    })
    webview.getWebContentsId = () => {
      if (!guest) {
        throw new Error('Not attached')
      }
      return guest.id
    }
    webview.getURL = () => source
    webview.getTitle = () => 'Current'
    webview.isLoading = () => guest?.loading ?? true
    webview.canGoBack = () => true
    webview.canGoForward = () => false
    webview.getZoomLevel = () => 0
    webview.setZoomLevel = () => {}
    const remove = webview.remove.bind(webview)
    webview.remove = () => {
      remove()
      guest?.destroy()
    }
    return webview
  }
  const create = vi.spyOn(document, 'createElement').mockImplementation(createProfileElement)
  const api = {
    preparePageAttach: async (args: { browserPageId: string; partition: string; url: string }) => {
      preparations.push(args)
      pageIds.add(args.browserPageId)
      const marker = prepareBrowserPageAttach(args.browserPageId, 99, args.partition, args.url)
      preparedByMarker.set(marker, args)
      return marker
    },
    registerGuest: async (args: {
      browserPageId: string
      webContentsId: number
      workspaceId: string
      worktreeId: string
      sessionProfileId: string | null
    }) => manager.registerGuest({ ...args, rendererWebContentsId: 99 }),
    unregisterGuest: async (args: {
      browserPageId: string
      webContentsId?: number
      replacement?: boolean
    }) => {
      unregistrations.push(args)
      if (
        args.replacement &&
        args.webContentsId !== undefined &&
        manager.getGuestWebContentsId(args.browserPageId) !== args.webContentsId
      ) {
        return false
      }
      manager.unregisterGuest(
        args.browserPageId,
        args.replacement ? 'guest-destroyed' : 'page-closed'
      )
      return true
    },
    reserveGuestDiscard: (args: { browserPageId: string; webContentsId: number }) => {
      const guest = native.get(args.webContentsId)
      if (!guest || !reserveBrowserPageDiscard(args.browserPageId, guest)) {
        return false
      }
      manager.unregisterGuest(args.browserPageId, 'guest-destroyed')
      return true
    },
    acknowledgeGuestRemoval: async (args: { browserPageId: string; webContentsId: number }) => {
      const guest = native.get(args.webContentsId)
      return guest ? acknowledgeBrowserPageRemoval(args.browserPageId, guest, 99) : false
    },
    isGuestRegistered: async (args: { browserPageId: string; webContentsId: number }) =>
      manager.getGuestWebContentsId(args.browserPageId) === args.webContentsId,
    notifyActiveTabChanged: vi.fn(async () => true),
    repairGuestRegistration: vi.fn(async () => true),
    setViewportOverride: vi.fn(async () => true),
    setAudioMuted: vi.fn(async () => true)
  }
  return {
    manager,
    guests,
    creations,
    preparations,
    unregistrations,
    api,
    pauseLoads() {
      autoFinish = false
    },
    finish(pageId: string) {
      finish(guests.get(pageId)!, webviews.get(pageId)!)
    },
    async settled() {
      for (const [pageId, guest] of guests) {
        if (guest.isDestroyed()) {
          continue
        }
        await waitForBrowserPageReady(pageId, guest.asWebContents())
      }
      await Promise.resolve()
    },
    async close() {
      for (const pageId of pageIds) {
        releaseBrowserPageMount(pageId)
        await closePersistentBrowserPage(pageId)
        closeBrowserMemoryPage(pageId)
      }
      manager.unregisterAll()
      create.mockRestore()
      registeredWebContentsIds.clear()
      webviewRegistry.clear()
      native.clear()
    }
  }
}
