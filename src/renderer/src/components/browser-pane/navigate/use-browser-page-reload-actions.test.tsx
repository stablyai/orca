// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { useBrowserPageReloadActions } from './use-browser-page-reload-actions'
import {
  acceptBrowserGuestMetadata,
  clearBrowserGuestMetadata
} from '../host-guest/browser-guest-metadata-cache'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reload hook calls only the webview methods stubbed here.
  return {
    getWebContentsId: vi.fn(() => 42),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    stop: vi.fn(),
    ...overrides
  } as unknown as Electron.WebviewTag
}

describe('useBrowserPageReloadActions', () => {
  afterEach(clearBrowserGuestMetadata)

  it('does not strand loading when a live guest rejects reload before it is ready', () => {
    const webview = createWebview({
      reload: vi.fn(() => {
        throw new Error('The WebView must be attached to the DOM')
      })
    })
    const onUpdatePageStateRef = { current: vi.fn() }
    const view = renderHook(() =>
      useBrowserPageReloadActions({
        browserTab: createBrowserTab(),
        webviewRef: { current: webview },
        retryGuestRecoveryRef: { current: vi.fn() },
        onUpdatePageStateRef
      })
    )

    act(() => view.result.current.runReloadTrigger('button'))
    expect(onUpdatePageStateRef.current).not.toHaveBeenCalled()
  })

  it('navigates a restored page that never committed to its saved URL', () => {
    // Main publishes an empty URL for a guest that stopped before its first commit.
    acceptBrowserGuestMetadata({
      browserPageId: 'page-a',
      webContentsId: 42,
      revision: 1,
      navigationRevision: 0,
      kind: 'stop',
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      errorPage: false,
      loadError: null,
      hasCertificateFailure: false
    })
    const webview = createWebview({ addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const view = renderHook(() =>
      useBrowserPageReloadActions({
        browserTab: createBrowserTab({ url: 'https://example.test/restored' }),
        webviewRef: { current: webview },
        retryGuestRecoveryRef: { current: vi.fn() },
        onUpdatePageStateRef: { current: vi.fn() }
      })
    )

    act(() => view.result.current.runReloadTrigger('button'))
    expect(webview.reload).not.toHaveBeenCalled()
    expect(webview.src).toBe('https://example.test/restored')
  })
})
