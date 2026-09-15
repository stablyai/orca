// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useBrowserPageWebviewUrlSync } from './use-browser-page-webview-url-sync'

describe('useBrowserPageWebviewUrlSync', () => {
  function createTestWebview(initialSrc: string) {
    return {
      src: initialSrc,
      getAttribute: vi.fn((attr: string) => (attr === 'src' ? initialSrc : null)),
      getURL: vi.fn(() => initialSrc),
      focus: vi.fn()
    } as unknown as Electron.WebviewTag
  }

  it('does not re-navigate when webview has equivalent URL with playback timestamp', () => {
    const webview = createTestWebview('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s')
    const webviewRef = { current: webview }
    const lastKnownWebviewUrlRef = {
      current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s'
    }
    const trackNextLoadingEventRef = { current: false }

    renderHook(() =>
      useBrowserPageWebviewUrlSync({
        browserTabId: 'tab-1',
        browserTabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        browserTabLoading: false,
        isActive: true,
        isPaintable: true,
        slotViewport: document.createElement('div'),
        webviewRef,
        chromeHeaderRef: { current: null },
        lastKnownWebviewUrlRef,
        trackNextLoadingEventRef,
        keepAddressBarFocusRef: { current: false },
        addressBarInputRef: { current: null },
        browserTabUrlRef: { current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        addressBarValueRef: { current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        onUpdatePageStateRef: { current: vi.fn() },
        focusWebviewNow: vi.fn(() => true)
      })
    )

    // The webview src must NOT be overwritten with the non-timestamped URL
    expect(webview.src).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s')
  })

  it('navigates when URL points to a genuinely different page', () => {
    const webview = createTestWebview('https://www.youtube.com/watch?v=oldVideo')
    const webviewRef = { current: webview }
    const lastKnownWebviewUrlRef = {
      current: 'https://www.youtube.com/watch?v=oldVideo'
    }
    const trackNextLoadingEventRef = { current: false }

    renderHook(() =>
      useBrowserPageWebviewUrlSync({
        browserTabId: 'tab-1',
        browserTabUrl: 'https://www.youtube.com/watch?v=newVideo',
        browserTabLoading: false,
        isActive: true,
        isPaintable: true,
        slotViewport: document.createElement('div'),
        webviewRef,
        chromeHeaderRef: { current: null },
        lastKnownWebviewUrlRef,
        trackNextLoadingEventRef,
        keepAddressBarFocusRef: { current: false },
        addressBarInputRef: { current: null },
        browserTabUrlRef: { current: 'https://www.youtube.com/watch?v=newVideo' },
        addressBarValueRef: { current: 'https://www.youtube.com/watch?v=newVideo' },
        onUpdatePageStateRef: { current: vi.fn() },
        focusWebviewNow: vi.fn(() => true)
      })
    )

    // The webview src is navigated to the new URL
    expect(webview.src).toBe('https://www.youtube.com/watch?v=newVideo')
  })

  it('navigates when the target carries an explicit timestamp the webview lacks', () => {
    const target = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120s'
    const webview = createTestWebview('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s')
    const webviewRef = { current: webview }
    const lastKnownWebviewUrlRef = {
      current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=45s'
    }
    const trackNextLoadingEventRef = { current: false }

    renderHook(() =>
      useBrowserPageWebviewUrlSync({
        browserTabId: 'tab-1',
        browserTabUrl: target,
        browserTabLoading: false,
        isActive: true,
        isPaintable: true,
        slotViewport: document.createElement('div'),
        webviewRef,
        chromeHeaderRef: { current: null },
        lastKnownWebviewUrlRef,
        trackNextLoadingEventRef,
        keepAddressBarFocusRef: { current: false },
        addressBarInputRef: { current: null },
        browserTabUrlRef: { current: target },
        addressBarValueRef: { current: target },
        onUpdatePageStateRef: { current: vi.fn() },
        focusWebviewNow: vi.fn(() => true)
      })
    )

    // Why: timestamp-only differences are otherwise equivalent — without the
    // explicit-t check the seek to t=120s would be silently suppressed.
    expect(webview.src).toBe(target)
    expect(trackNextLoadingEventRef.current).toBe(true)
  })
})
