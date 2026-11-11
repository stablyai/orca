// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'

import { BrowserClientPageRetainedRegistry } from './browser-client-page-retained-registry'

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
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('browser client page retained registry', () => {
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
