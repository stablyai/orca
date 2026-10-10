// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { useBrowserPageReloadActions } from './use-browser-page-reload-actions'

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => '' }))

function createBrowserTab(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: 'page-a',
    browserTabId: 'tab-a',
    url: 'https://example.test/',
    title: 'Example',
    loading: false,
    loadError: null,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    ...overrides
  } as BrowserPage
}

function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return {
    getWebContentsId: vi.fn(() => 42),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    ...overrides
  } as unknown as Electron.WebviewTag
}

describe('useBrowserPageReloadActions', () => {
  it('arms the lifecycle gate and exposes loading after an accepted reload', () => {
    const webview = createWebview()
    const trackNextLoadingEventRef = { current: false }
    const onUpdatePageStateRef = { current: vi.fn() }
    const view = renderHook(() =>
      useBrowserPageReloadActions({
        browserTab: createBrowserTab(),
        webviewRef: { current: webview },
        trackNextLoadingEventRef,
        retryGuestRecoveryRef: { current: vi.fn() },
        onUpdatePageStateRef
      })
    )

    act(() => view.result.current.runReloadTrigger('button'))

    expect(webview.reload).toHaveBeenCalledTimes(1)
    expect(trackNextLoadingEventRef.current).toBe(true)
    expect(onUpdatePageStateRef.current).toHaveBeenCalledWith('page-a', { loading: true })
  })

  it('does not strand loading when a live guest rejects reload before it is ready', () => {
    const webview = createWebview({
      reload: vi.fn(() => {
        throw new Error('The WebView must be attached to the DOM')
      })
    })
    const trackNextLoadingEventRef = { current: false }
    const onUpdatePageStateRef = { current: vi.fn() }
    const view = renderHook(() =>
      useBrowserPageReloadActions({
        browserTab: createBrowserTab(),
        webviewRef: { current: webview },
        trackNextLoadingEventRef,
        retryGuestRecoveryRef: { current: vi.fn() },
        onUpdatePageStateRef
      })
    )

    act(() => view.result.current.runReloadTrigger('button'))

    expect(trackNextLoadingEventRef.current).toBe(false)
    expect(onUpdatePageStateRef.current).not.toHaveBeenCalled()
  })
})
