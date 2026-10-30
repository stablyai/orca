// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admitBrowserPageMount,
  isBrowserPageMountAdmitted,
  releaseBrowserPageMount
} from './browser-page-mount-admission'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'

const PAGE_ID = 'page-1'

function createLoadingHandlers(currentUrl: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: did-stop-loading only reads these four webview getters.
  const webview = {
    getURL: () => currentUrl,
    getTitle: () => 'title',
    canGoBack: () => false,
    canGoForward: () => false,
    src: currentUrl
  } as unknown as Electron.WebviewTag
  const ref = <T>(value: T) => ({ current: value })
  return createBrowserPageWebviewLoadingHandlers({
    webview,
    browserTabId: PAGE_ID,
    faviconUrlRef: ref(null),
    browserTabUrlRef: ref(currentUrl),
    addressBarValueRef: ref(currentUrl),
    addressBarInputRef: ref(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(null),
    keepAddressBarFocusRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    onUpdatePageStateRef: ref(vi.fn()),
    onSetUrlRef: ref(vi.fn()),
    setAddressBarValue: vi.fn(),
    focusAddressBarNow: () => false
  })
}

afterEach(() => {
  releaseBrowserPageMount(PAGE_ID)
})

describe('browser page mount admission', () => {
  it('ends once the guest finishes its first load', () => {
    admitBrowserPageMount(PAGE_ID)
    const loading = createLoadingHandlers('https://example.com/')
    expect(isBrowserPageMountAdmitted(PAGE_ID)).toBe(true)

    loading.handleDidStopLoading()
    expect(isBrowserPageMountAdmitted(PAGE_ID)).toBe(false)
  })

  it('ends when the first load fails', () => {
    admitBrowserPageMount(PAGE_ID)
    const loading = createLoadingHandlers('chrome-error://chromewebdata/')

    loading.handleDidStopLoading()
    expect(isBrowserPageMountAdmitted(PAGE_ID)).toBe(false)
  })
})
