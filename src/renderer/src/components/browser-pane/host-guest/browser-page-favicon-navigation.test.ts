import { describe, expect, it, vi } from 'vitest'
import { createBrowserPageWebviewNavigationHandlers } from './browser-page-webview-navigation-handlers'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'

const ICON_URL = 'https://example.com/favicon.ico'

function createHarness(startUrl = 'https://example.com/one') {
  let currentUrl = startUrl
  const faviconUrlRef = { current: ICON_URL as string | null }
  const updatePage = vi.fn<(tabId: string, updates: BrowserTabPageState) => void>()
  const addHistory = vi.fn<(url: string, title: string, faviconUrl?: string) => void>()
  const ref = <T>(current: T) => ({ current })
  const handlers = createBrowserPageWebviewNavigationHandlers({
    webview: { getURL: () => currentUrl } as Electron.WebviewTag,
    browserTabId: 'page-1',
    browserTabUrl: startUrl,
    recoveryNavigationValidationRef: ref(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(startUrl),
    addressBarInputRef: ref(null),
    onSetUrlRef: ref(vi.fn()),
    onUpdatePageStateRef: ref(updatePage),
    addBrowserHistoryEntryRef: ref(addHistory),
    faviconUrlRef,
    setAddressBarValue: vi.fn(),
    annotationViewportBridgeTokenRef: ref('token'),
    setBrowserOverlayViewport: vi.fn()
  })

  return {
    addHistory,
    faviconUrlRef,
    handlers,
    setCurrentUrl: (url: string) => {
      currentUrl = url
    },
    updatePage
  }
}

describe('browser page favicon navigation', () => {
  it('retains an icon for same-origin navigation', () => {
    const harness = createHarness()

    harness.handlers.handleDidStartNavigation({
      isMainFrame: true,
      isInPlace: false,
      url: 'https://example.com/two'
    } as Electron.DidStartNavigationEvent)

    expect(harness.faviconUrlRef.current).toBe(ICON_URL)
    expect(harness.updatePage).not.toHaveBeenCalled()
  })

  it('clears an icon before filing history for a different origin', () => {
    const harness = createHarness()
    const destination = 'https://example.org/two'

    harness.handlers.handleDidStartNavigation({
      isMainFrame: true,
      isInPlace: false,
      url: destination
    } as Electron.DidStartNavigationEvent)
    harness.setCurrentUrl(destination)
    harness.handlers.handleTitleUpdate({ title: 'Example org' })

    expect(harness.faviconUrlRef.current).toBeNull()
    expect(harness.updatePage).toHaveBeenCalledWith('page-1', { faviconUrl: null })
    expect(harness.addHistory).toHaveBeenCalledWith(destination, 'Example org', undefined)
  })

  it('clears an icon when a same-origin navigation redirects elsewhere', () => {
    const harness = createHarness()

    harness.handlers.handleDidRedirectNavigation({
      isMainFrame: true,
      isInPlace: false,
      url: 'https://example.org/redirected'
    } as Electron.DidRedirectNavigationEvent)

    expect(harness.faviconUrlRef.current).toBeNull()
  })

  it('uses the first displayable icon Chromium reports', () => {
    const harness = createHarness()

    harness.handlers.handleFaviconUpdate({
      favicons: ['data:,', 'https://example.com/second.ico']
    })

    expect(harness.faviconUrlRef.current).toBe('https://example.com/second.ico')
  })
})
