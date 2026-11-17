// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserClientPageRendererIdentity } from '../../../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'

import { BrowserClientPageRetainedRegistry } from './browser-client-page-retained-registry'
import { clearBrowserGuestMetadata } from '../metadata/browser-guest-metadata-cache'

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

afterEach(() => {
  clearBrowserGuestMetadata()
  document.body.innerHTML = ''
  vi.useRealTimers()
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
