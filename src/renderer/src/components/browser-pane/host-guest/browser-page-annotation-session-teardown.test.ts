import { describe, expect, it, vi } from 'vitest'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'
import { createBrowserPageWebviewNavigationHandlers } from './browser-page-webview-navigation-handlers'

const TAB_ID = 'tab-1'
const URL = 'https://example.test/app'

function createHarness() {
  vi.stubGlobal('document', { activeElement: null })
  const clearBrowserPageAnnotations = vi.fn()
  const cancelGrabSession = vi.fn()
  const setBrowserOverlayViewport = vi.fn()
  const ref = <T>(value: T) => ({ current: value })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture stub for the Electron webview getters.
  const webview = {
    getURL: () => URL,
    getTitle: () => 'title',
    canGoBack: () => false,
    canGoForward: () => false,
    src: URL
  } as unknown as Electron.WebviewTag

  const navigation = createBrowserPageWebviewNavigationHandlers({
    webview,
    browserTabId: TAB_ID,
    browserTabUrl: URL,
    recoveryNavigationValidationRef: ref(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(URL),
    addressBarInputRef: ref(null),
    onSetUrlRef: ref(vi.fn()),
    onUpdatePageStateRef: ref(vi.fn()),
    addBrowserHistoryEntryRef: ref(vi.fn()),
    faviconUrlRef: ref(null),
    setAddressBarValue: vi.fn(),
    annotationViewportBridgeTokenRef: ref('token'),
    setBrowserOverlayViewport,
    clearBrowserPageAnnotationsRef: { current: clearBrowserPageAnnotations },
    cancelGrabSessionRef: { current: cancelGrabSession }
  })
  // Why no clearing callbacks here: the loading factory must have no annotation-clearing path
  // at all; the session reset rides the cancel callback wired above.
  const { handleDidStartLoading } = createBrowserPageWebviewLoadingHandlers({
    webview,
    browserTabId: TAB_ID,
    faviconUrlRef: ref(null),
    browserTabUrlRef: ref(URL),
    addressBarValueRef: ref(URL),
    addressBarInputRef: ref(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: ref<string | null>(URL),
    trackNextLoadingEventRef: ref(true),
    keepAddressBarFocusRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    onUpdatePageStateRef: ref(vi.fn()),
    onSetUrlRef: ref(vi.fn()),
    setAddressBarValue: vi.fn(),
    focusAddressBarNow: () => false
  })

  // Real same-document navigations carry no usable isInPlace on did-start-navigation; this fixture mirrors that.
  const startNavigation = (isMainFrame: boolean): void =>
    navigation.handleDidStartNavigation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial navigation-event fixture.
      { isMainFrame, url: URL } as Electron.DidStartNavigationEvent
    )

  return {
    startNavigation,
    commitNavigation: (isMainFrame?: boolean) =>
      navigation.handleFullDidNavigate({ url: URL, isMainFrame }),
    navigateInPage: () => navigation.handleDidNavigateInPage({ url: URL }),
    handleDidStartLoading,
    clearBrowserPageAnnotations,
    cancelGrabSession,
    setBrowserOverlayViewport
  }
}

describe('browser page annotate session teardown on guest loads', () => {
  it('tears the whole session down when a main-frame navigation commits, grab reset included', () => {
    const h = createHarness()

    h.commitNavigation()

    // Why the grab reset matters: without it the card disappears but the grab hook stays
    // in 'confirming', a half-closed session only Esc can dismiss.
    expect(h.clearBrowserPageAnnotations).toHaveBeenCalledWith(TAB_ID)
    expect(h.setBrowserOverlayViewport).toHaveBeenCalledWith({ scrollX: 0, scrollY: 0, version: 0 })
    expect(h.cancelGrabSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the session alive across in-page navigations (hash/pushState/replaceState polling)', () => {
    const h = createHarness()

    h.startNavigation(true)
    h.navigateInPage()

    expect(h.clearBrowserPageAnnotations).not.toHaveBeenCalled()
    expect(h.cancelGrabSession).not.toHaveBeenCalled()
  })

  it('keeps the session alive across subframe loads (iframe-style polling refreshes)', () => {
    const h = createHarness()

    h.startNavigation(false)
    // Defensive: a subframe commit must never reach the teardown even if a guest reported it.
    h.commitNavigation(false)
    // A subframe load also spins the loading throbber on every refresh.
    h.handleDidStartLoading()

    expect(h.clearBrowserPageAnnotations).not.toHaveBeenCalled()
    expect(h.cancelGrabSession).not.toHaveBeenCalled()
  })

  it('no longer tears anything down on did-start-loading alone', () => {
    const h = createHarness()

    // The old handler cleared the annotation card on every throbber start — the bug that
    // killed the card on iframe-polling pages.
    h.handleDidStartLoading()

    expect(h.clearBrowserPageAnnotations).not.toHaveBeenCalled()
    expect(h.cancelGrabSession).not.toHaveBeenCalled()
  })
})
