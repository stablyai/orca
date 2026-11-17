// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import {
  acceptBrowserGuestMetadata,
  clearBrowserGuestMetadata,
  issueBrowserGuestNavigation,
  subscribeBrowserGuestMetadata
} from './browser-guest-metadata-cache'

function snapshot(
  webContentsId: number,
  revision: number,
  title = 'Current'
): BrowserGuestMetadata {
  return {
    browserPageId: 'page',
    webContentsId,
    revision,
    navigationRevision: 1,
    kind: 'title',
    url: 'https://example.test/',
    title,
    loading: false,
    canGoBack: true,
    canGoForward: false,
    errorPage: false,
    loadError: null,
    hasCertificateFailure: false
  }
}
function tag(id: number): Electron.WebviewTag {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM tag with the only native method used by the cache.
  return Object.assign(document.createElement('webview'), {
    getWebContentsId: () => id
  }) as Electron.WebviewTag
}
afterEach(clearBrowserGuestMetadata)

describe('guest metadata lifetime cache', () => {
  it('initializes a successor after an eventless command returns unchanged native state', async () => {
    const state = snapshot(1, 1, 'Idle A')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { getGuestMetadata: vi.fn(async () => state) } }
    })
    acceptBrowserGuestMetadata(state)
    const webview = tag(1)
    const first = subscribeBrowserGuestMetadata('page', webview, () => {})
    issueBrowserGuestNavigation(webview, () => {})
    first()
    const observed: (BrowserGuestMetadata | null)[] = []
    const dispose = subscribeBrowserGuestMetadata('page', webview, (state) => observed.push(state))
    await vi.waitFor(() =>
      expect(observed.at(-1)).toMatchObject({ title: 'Idle A', loading: false })
    )
    dispose()
  })

  it('discards a late initial read after a newer event and fences a replacement guest', async () => {
    let resolve!: (state: BrowserGuestMetadata) => void
    const getGuestMetadata = vi.fn(
      () =>
        new Promise<BrowserGuestMetadata>((done) => {
          resolve = done
        })
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { getGuestMetadata } }
    })
    const webview = tag(1)
    const observed: (BrowserGuestMetadata | null)[] = []
    const dispose = subscribeBrowserGuestMetadata('page', webview, (state) => observed.push(state))
    await Promise.resolve()
    acceptBrowserGuestMetadata(snapshot(1, 2, 'Newer'))
    resolve(snapshot(1, 1, 'Stale'))
    await Promise.resolve()
    expect(observed.map((state) => state?.title)).toEqual(['Newer'])
    webview.getWebContentsId = () => 2
    webview.dispatchEvent(new Event('did-attach'))
    acceptBrowserGuestMetadata(snapshot(1, 3, 'Old guest'))
    acceptBrowserGuestMetadata(snapshot(2, 1, 'Replacement'))
    expect(observed.map((state) => state?.title)).toEqual(['Newer', 'Replacement'])
    dispose()
  })
})
