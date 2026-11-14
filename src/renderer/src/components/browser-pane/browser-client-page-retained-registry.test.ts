// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'

import { BrowserClientPageRetainedRegistry } from './browser-client-page-retained-registry'
import {
  clearBrowserGuestMetadata,
  issueBrowserGuestNavigation,
  subscribeBrowserGuestMetadata
} from './host-guest/browser-guest-metadata-cache'

const PAGE: BrowserClientPageRendererIdentity = {
  partition: 'persist:route-a',
  browserPageId: 'page-a',
  pageHostGeneration: 7
}

function createRig(
  options: {
    attachTimeoutMs?: number
    maxPages?: number
    maxPagesPerPartition?: number
  } = {}
) {
  const webviews: Electron.WebviewTag[] = []
  let nextId = 40
  const registry = new BrowserClientPageRetainedRegistry({
    document,
    ...options,
    createWebview: () => {
      const webview = document.createElement('webview') as Electron.WebviewTag
      Object.defineProperty(webview, 'getWebContentsId', {
        configurable: true,
        value: vi.fn(() => {
          if (webview.dataset.attached !== 'true') {
            throw new Error('guest not attached')
          }
          const current = Number(webview.dataset.webContentsId)
          if (Number.isInteger(current) && current > 0) {
            return current
          }
          const webContentsId = ++nextId
          webview.dataset.webContentsId = String(webContentsId)
          return webContentsId
        })
      })
      webviews.push(webview)
      return webview
    }
  })
  return { registry, webviews }
}

function attach(webview: Electron.WebviewTag): void {
  webview.dataset.attached = 'true'
  webview.dispatchEvent(new Event('did-attach'))
  webview.dispatchEvent(new Event('did-finish-load'))
  webview.dispatchEvent(new Event('did-stop-loading'))
}

afterEach(() => {
  clearBrowserGuestMetadata()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('browser client page retained registry', () => {
  it.each(['retire', 'dispose', 'renderer-loss'] as const)(
    'ends unpublished metadata on %s without a post-removal destroyed event',
    async (mode) => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { browser: { getGuestMetadata: async () => undefined } }
      })
      const { registry, webviews } = createRig()
      const mounting = registry.mountPage(PAGE)
      const webview = webviews[0]!
      attach(webview)
      await mounting
      const remove = webview.remove.bind(webview)
      webview.remove = () => {
        webview.dataset.attached = 'false'
        remove()
      }
      const received = vi.fn()
      const detach = subscribeBrowserGuestMetadata(PAGE.browserPageId, webview, received)
      if (mode !== 'dispose') {
        issueBrowserGuestNavigation(webview, () => {})
      }
      await Promise.resolve()
      if (mode === 'retire') {
        registry.retirePage(PAGE)
      } else if (mode === 'dispose') {
        registry.dispose()
      } else {
        // The owner runs first on native loss; its removal makes the tag ID unreadable.
        webview.dataset.attached = 'false'
        webview.dispatchEvent(new Event('render-process-gone'))
      }
      expect(received).toHaveBeenCalledExactlyOnceWith(null)
      expect(webview.isConnected).toBe(false)
      detach()
      registry.dispose()
    }
  )

  it('holds an attached generation until destruction and ignores wrong-generation retirement', async () => {
    const { registry, webviews } = createRig()
    const mounting = registry.mountPage(PAGE)
    const webview = webviews[0]!
    attach(webview)
    await mounting

    registry.retirePage({ ...PAGE, pageHostGeneration: 8 })
    expect(webview.isConnected).toBe(true)
    registry.retirePage(PAGE)
    expect(webview.isConnected).toBe(false)
    expect(registry.getMemoryProfile().retiringPageCount).toBe(1)
    await expect(registry.mountPage(PAGE)).rejects.toThrow(
      'browser_client_page_renderer_page_retiring'
    )

    webview.dispatchEvent(new Event('destroyed'))
    expect(registry.getMemoryProfile().retainedPageCount).toBe(0)
  })
})

it('waits for the bootstrap finish and subsequent stop before granting creation readiness', async () => {
  const { registry, webviews } = createRig()
  const mounting = registry.mountPage(PAGE)
  const webview = webviews[0]!
  webview.dataset.attached = 'true'
  webview.dispatchEvent(new Event('did-attach'))
  webview.dispatchEvent(new Event('dom-ready'))
  webview.dispatchEvent(new Event('did-stop-loading'))
  let available = false
  void mounting.then(() => {
    available = true
  })
  await Promise.resolve()
  expect(available).toBe(false)
  webview.dispatchEvent(new Event('did-finish-load'))
  await Promise.resolve()
  expect(available).toBe(false)
  webview.dispatchEvent(new Event('did-stop-loading'))
  await expect(mounting).resolves.toEqual({ webContentsId: 41 })
  registry.dispose()
})
