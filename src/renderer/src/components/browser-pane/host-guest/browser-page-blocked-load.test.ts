// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'
import type {
  BrowserPageFailLoadEvent,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

const PREVIOUS = 'https://news.example/'

function handlersOnPreviousPage() {
  const updates: BrowserTabPageState[] = []
  const ref = <T>(value: T) => ({ current: value })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these webview members.
  const webview = {
    getURL: () => PREVIOUS,
    getTitle: () => 'News',
    canGoBack: () => true,
    canGoForward: () => false,
    src: PREVIOUS
  } as unknown as Electron.WebviewTag
  const handlers = createBrowserPageWebviewLoadingHandlers({
    webview,
    browserTabId: 'tab-1',
    faviconUrlRef: ref(null),
    browserTabUrlRef: ref(PREVIOUS),
    addressBarValueRef: ref(PREVIOUS),
    addressBarInputRef: ref(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(PREVIOUS),
    keepAddressBarFocusRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    onUpdatePageStateRef: ref((_tabId: string, next: BrowserTabPageState) => updates.push(next)),
    onSetUrlRef: ref(vi.fn()),
    setAddressBarValue: vi.fn(),
    focusAddressBarNow: () => false
  })
  return { handlers, updates }
}

function failure(errorCode: number, validatedURL: string): BrowserPageFailLoadEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveBrowserWebviewLoadFailure reads only these fields.
  return {
    errorCode,
    errorDescription: 'failed',
    validatedURL,
    isMainFrame: true
  } as BrowserPageFailLoadEvent
}

describe('a page load that never commits', () => {
  it('keeps an extension block on screen while the tab still shows the previous page', () => {
    const { handlers, updates } = handlersOnPreviousPage()
    handlers.handleFailLoad(failure(-20, 'https://ads.example/'))
    handlers.handleDidStopLoading()
    expect(updates.at(-1)?.loadError).toMatchObject({ code: -20 })
  })

  it('still clears other failures the previous page outlived', () => {
    const { handlers, updates } = handlersOnPreviousPage()
    handlers.handleFailLoad(failure(-105, 'https://gone.example/'))
    handlers.handleDidStopLoading()
    expect(updates.at(-1)?.loadError).toBeNull()
  })
})
