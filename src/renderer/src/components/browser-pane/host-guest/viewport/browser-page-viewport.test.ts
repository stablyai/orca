// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import {
  clearBrowserGuestMetadata,
  subscribeBrowserGuestMetadata
} from '../metadata/browser-guest-metadata-cache'
import { registerPersistentWebview, unregisterPersistentWebview } from '../webview-registry'
import {
  getBrowserOverlaySlotViewport,
  ensureBrowserPageViewport,
  registerBrowserOverlaySlotViewport,
  removeBrowserPageViewport,
  setBrowserPageAgentViewportSize,
  setBrowserPageViewportPresetSize
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM tag with the native identity method used by these owners.
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
