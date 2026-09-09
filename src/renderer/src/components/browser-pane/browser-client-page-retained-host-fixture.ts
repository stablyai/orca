import { vi } from 'vitest'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser-client-page-renderer-protocol'
import {
  BrowserClientPageRetainedRegistry,
  type BrowserClientPageVisibleAttachment
} from './browser-client-page-retained-registry'

/**
 * A real client-hosted retained page — registry, body-level host, attached guest — for suites
 * that assert what a drag does to the host's pointer-events. Everything below the fake guest is
 * the shipping code: the registry creates and enrols the host, and the visible attachment is the
 * one the pane's attach effect uses.
 */
export const RETAINED_FIXTURE_PAGE: BrowserClientPageRendererIdentity = {
  partition: 'persist:route-a',
  browserPageId: 'page-a',
  pageHostGeneration: 3
}

export type RetainedHostFixture = {
  registry: BrowserClientPageRetainedRegistry
  container: HTMLElement
  /** The body-level fixed overlay whose pointer-events decide whether a drag reaches the document. */
  host: () => HTMLDivElement
  mount: (identity?: BrowserClientPageRendererIdentity) => Promise<void>
  attach: (identity?: BrowserClientPageRendererIdentity) => BrowserClientPageVisibleAttachment
}

const openFixtures: BrowserClientPageRetainedRegistry[] = []

export function createRetainedHostFixture(): RetainedHostFixture {
  const webviews: Electron.WebviewTag[] = []
  let nextId = 40
  const registry = new BrowserClientPageRetainedRegistry({
    document,
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
  openFixtures.push(registry)
  const container = document.createElement('div')
  document.body.appendChild(container)
  return {
    registry,
    container,
    host: () =>
      document.querySelector<HTMLDivElement>('[data-browser-client-page-retained-root] > div')!,
    mount: async (identity = RETAINED_FIXTURE_PAGE) => {
      const mounting = registry.mountPage(identity)
      const webview = webviews.at(-1)!
      webview.dataset.attached = 'true'
      webview.dispatchEvent(new Event('did-attach'))
      await mounting
    },
    attach: (identity = RETAINED_FIXTURE_PAGE) => registry.attachPage(identity, container)
  }
}

export function disposeRetainedHostFixtures(): void {
  for (const registry of openFixtures.splice(0)) {
    registry.dispose()
  }
}
