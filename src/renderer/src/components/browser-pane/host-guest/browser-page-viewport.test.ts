// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import {
  acceptBrowserGuestMetadata,
  clearBrowserGuestMetadata,
  issueBrowserGuestNavigation,
  subscribeBrowserGuestMetadata
} from './browser-guest-metadata-cache'
import {
  destroyPersistentWebview,
  registerPersistentWebview,
  replacePersistentWebview,
  unregisterPersistentWebview
} from './webview-registry'
import {
  getBrowserOverlaySlotViewport,
  ensureBrowserPageViewport,
  registerBrowserOverlaySlotViewport,
  removeBrowserPageViewport,
  setBrowserPageAgentViewportSize,
  setBrowserPageViewportPresetSize,
  subscribeBrowserOverlaySlotViewport
} from './browser-page-viewport'

function mountSlotViewport(workspaceTabId: string): HTMLDivElement {
  const root = document.createElement('div')
  root.className = 'relative flex min-h-0 flex-1 flex-col'
  document.body.appendChild(root)
  registerBrowserOverlaySlotViewport(workspaceTabId, root)
  return root
}

afterEach(() => {
  clearBrowserGuestMetadata()
  for (const id of ['page-1', 'page-2']) {
    unregisterPersistentWebview(id)
    removeBrowserPageViewport(id)
    setBrowserPageAgentViewportSize(id, null)
    setBrowserPageViewportPresetSize(id, null)
  }
  for (const id of ['workspace-1']) {
    getBrowserOverlaySlotViewport(id)?.remove()
    registerBrowserOverlaySlotViewport(id, null)
  }
})

describe('local guest metadata disposal', () => {
  function prepareGuest() {
    let finish!: (value: BrowserGuestMetadata | undefined) => void
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          unregisterGuest: async () => {},
          getGuestMetadata: () => new Promise((resolve) => (finish = resolve))
        }
      }
    })
    const root = mountSlotViewport('workspace-1')
    const viewport = ensureBrowserPageViewport('page-1', 'workspace-1')!
    let readable = true
    const webview = Object.assign(document.createElement('webview'), {
      getWebContentsId: () => {
        if (!readable) {
          throw new Error('guest detached')
        }
        return 41
      }
    }) as Electron.WebviewTag
    const remove = webview.remove.bind(webview)
    webview.remove = () => {
      readable = false
      remove()
    }
    viewport.content.appendChild(webview)
    registerPersistentWebview('page-1', webview)
    const observed: (BrowserGuestMetadata | null)[] = []
    const detach = subscribeBrowserGuestMetadata('page-1', webview, (state) => observed.push(state))
    return {
      root,
      webview,
      observed,
      detach,
      makeUnreadable: () => {
        readable = false
      },
      finish: () =>
        finish({
          browserPageId: 'page-1',
          webContentsId: 41,
          revision: 1,
          navigationRevision: 1,
          kind: 'snapshot',
          url: 'https://old.test/',
          title: 'Old',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          errorPage: false,
          loadError: null,
          hasCertificateFailure: false
        })
    }
  }

  it.each(['destroy', 'replace'] as const)(
    'ends an unpublished guest on %s and ignores its late query',
    async (mode) => {
      const rig = prepareGuest()
      if (mode === 'replace') {
        issueBrowserGuestNavigation(rig.webview, () => {})
      }
      await Promise.resolve()
      if (mode === 'replace') {
        rig.detach()
      }
      await (mode === 'destroy'
        ? destroyPersistentWebview('page-1')
        : replacePersistentWebview('page-1', { preserveViewport: true }))
      rig.finish()
      await Promise.resolve()
      await Promise.resolve()
      expect(rig.observed).toEqual(mode === 'destroy' ? [null] : [])
      const replacement = Object.assign(document.createElement('webview'), {
        getWebContentsId: () => 42
      }) as Electron.WebviewTag
      const receive = vi.fn()
      const detach = subscribeBrowserGuestMetadata('page-1', replacement, receive)
      acceptBrowserGuestMetadata({
        browserPageId: 'page-1',
        webContentsId: 42,
        revision: 1,
        navigationRevision: 1,
        kind: 'snapshot',
        url: 'https://replacement.test/',
        title: 'Replacement',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        errorPage: false,
        loadError: null,
        hasCertificateFailure: false
      })
      expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Replacement' }))
      detach()
      rig.detach()
    }
  )

  it('ends guests under a removed slot even when their native identity is already unreadable', async () => {
    const rig = prepareGuest()
    await Promise.resolve()
    rig.root.remove()
    rig.makeUnreadable()
    registerBrowserOverlaySlotViewport('workspace-1', null)
    rig.finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(rig.observed).toEqual([null])
    rig.detach()
  })
})

describe('subscribeBrowserOverlaySlotViewport', () => {
  it('does not let a repeated stale unsubscribe drop a newer subscriber set', () => {
    const stale = subscribeBrowserOverlaySlotViewport('workspace-1', () => {})
    stale()

    let notified = 0
    const active = subscribeBrowserOverlaySlotViewport('workspace-1', () => {
      notified += 1
    })
    // StrictMode/double-cleanup: the emptied first Set must not evict the replacement.
    stale()

    mountSlotViewport('workspace-1')

    expect(notified).toBe(1)
    active()
  })
})
