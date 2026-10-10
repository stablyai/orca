// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPageWebviewGuestSession } from './browser-page-webview-guest-session'

const mocks = vi.hoisted(() => ({
  replace: vi.fn(async () => {}),
  registeredIds: new Map<string, number>(),
  isRegistered: vi.fn(async () => true)
}))
vi.mock('./webview-registry', () => ({
  registeredWebContentsIds: mocks.registeredIds,
  replacePersistentWebview: mocks.replace
}))
vi.mock('../describe-page/browser-page-load-error', () => ({ browserPageExists: () => true }))

function createPage(id: string) {
  const webview = document.createElement('webview') as Electron.WebviewTag
  webview.getWebContentsId = vi.fn(() => {
    if (!webview.isConnected) {
      throw new Error('guest destroyed')
    }
    return 1
  })
  document.body.appendChild(webview)
  const paintable = { current: false }
  const setGeneration = vi.fn()
  const ref = <T>(current: T) => ({ current })
  const session = createBrowserPageWebviewGuestSession({
    webview,
    browserTabId: id,
    workspaceId: 'browser-1',
    worktreeId: 'wt-1',
    sessionProfileId: null,
    webviewRef: ref(webview),
    isPaintableRef: paintable,
    guestRecoveryPendingRef: ref(false),
    browserTabUrlRef: ref('https://example.test'),
    addressBarValueRef: ref('https://example.test'),
    activeLoadFailureRef: ref(null),
    recoveryNavigationValidationRef: ref(null),
    keepAddressBarFocusRef: ref(false),
    paneZoomLevelRef: ref(0),
    viewportPresetIdRef: ref(null),
    onUpdatePageStateRef: ref(vi.fn()),
    setGuestRecoveryGeneration: setGeneration,
    setBrowserZoomPercent: vi.fn(),
    focusAddressBarNow: () => false,
    syncNavigationState: vi.fn(),
    syncBrowserAnnotationViewportBridge: vi.fn()
  })
  return { webview, paintable, setGeneration, recovery: session.guestRecovery }
}

describe('retained browser panes after guest eviction', () => {
  const pages: ReturnType<typeof createPage>[] = []
  beforeEach(() => {
    mocks.replace.mockClear()
    mocks.isRegistered.mockClear()
    mocks.registeredIds.clear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { isGuestRegistered: mocks.isRegistered } }
    })
  })
  afterEach(() => {
    for (const page of pages.splice(0)) {
      page.recovery.dispose()
      page.webview.remove()
    }
  })

  it('rebuilds only the selected page after evicting 200 hidden guests', async () => {
    for (let index = 0; index < 200; index++) {
      const page = createPage(`page-${index}`)
      pages.push(page)
      page.webview.remove()
      page.recovery.validateAfterResume()
    }
    expect(mocks.replace).not.toHaveBeenCalled()
    pages[199].paintable.current = true
    pages[199].recovery.validateAfterResume()
    await vi.waitFor(() => expect(pages[199].setGeneration).toHaveBeenCalledOnce())
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith('page-199')
    expect(pages.slice(0, 199).every((page) => page.setGeneration.mock.calls.length === 0)).toBe(
      true
    )
    expect(mocks.isRegistered).not.toHaveBeenCalled()
  })

  it('reuses a connected registered guest on reactivation', async () => {
    const page = createPage('page-1')
    pages.push(page)
    mocks.registeredIds.set('page-1', 1)
    page.paintable.current = true
    page.recovery.validateAfterResume()
    await vi.waitFor(() => expect(mocks.isRegistered).toHaveBeenCalledOnce())
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(page.setGeneration).not.toHaveBeenCalled()
  })

  it('does not mistake a connected guest awaiting dom-ready for an evicted guest', async () => {
    const page = createPage('page-1')
    pages.push(page)
    vi.mocked(page.webview.getWebContentsId).mockImplementation(() => {
      throw new Error('not ready')
    })
    page.paintable.current = true
    page.recovery.validateAfterResume()
    await vi.waitFor(() => expect(page.webview.getWebContentsId).toHaveBeenCalledOnce())
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(page.setGeneration).not.toHaveBeenCalled()
  })
})
