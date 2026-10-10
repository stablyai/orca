// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'
import { useBrowserPageWebviewUrlSync } from './use-browser-page-webview-url-sync'

const CHROMIUM_ERROR_URL = 'chrome-error://chromewebdata/'

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function renderUrlSync(guestUrl: () => string): {
  updates: [string, BrowserTabPageState][]
  unmount: () => void
} {
  const updates: [string, BrowserTabPageState][] = []
  const webview = { getURL: () => guestUrl(), src: '' } as unknown as Electron.WebviewTag
  const view = renderHook(() =>
    useBrowserPageWebviewUrlSync({
      browserTabId: 'tab-1',
      browserTabUrl: 'https://example.test/slow',
      browserTabLoading: true,
      isActive: true,
      isPaintable: true,
      slotViewport: null,
      webviewRef: { current: webview },
      chromeHeaderRef: { current: null },
      lastKnownWebviewUrlRef: { current: 'https://example.test/slow' },
      trackNextLoadingEventRef: { current: false },
      keepAddressBarFocusRef: { current: false },
      addressBarInputRef: { current: null },
      browserTabUrlRef: { current: 'https://example.test/slow' },
      addressBarValueRef: { current: 'https://example.test/slow' },
      onUpdatePageStateRef: {
        current: (tabId, patch) => {
          updates.push([tabId, patch])
        }
      },
      focusWebviewNow: () => false
    })
  )
  return { updates, unmount: view.unmount }
}

beforeEach(() => {
  vi.useFakeTimers()
  setDocumentVisibility('visible')
})

afterEach(() => {
  cleanup()
  setDocumentVisibility('visible')
  vi.useRealTimers()
})

describe('chromium error page poll visibility gate', () => {
  it('stops the 250ms poll while hidden and re-detects the error page on return', () => {
    let guestUrl = 'https://example.test/slow'
    const { updates, unmount } = renderUrlSync(() => guestUrl)

    // Visible and still loading: the fallback poll is armed.
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1_000))
    expect(updates).toHaveLength(0)

    setDocumentVisibility('hidden')
    expect(vi.getTimerCount()).toBe(0)

    // The guest lands on a chrome-error page while nobody can see the surface.
    guestUrl = CHROMIUM_ERROR_URL
    act(() => vi.advanceTimersByTime(10_000))
    expect(updates).toHaveLength(0)

    // Returning re-reads the durable guest URL, so the loadError is not lost.
    setDocumentVisibility('visible')
    expect(updates).toHaveLength(1)
    expect(updates[0]?.[1].loadError?.validatedUrl).toBe('https://example.test/slow')
    expect(updates[0]?.[1].loading).toBe(false)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls unchanged while the window stays visible', () => {
    let guestUrl = 'https://example.test/slow'
    const { updates } = renderUrlSync(() => guestUrl)

    guestUrl = CHROMIUM_ERROR_URL
    act(() => vi.advanceTimersByTime(250))
    expect(updates).toHaveLength(1)
  })
})
