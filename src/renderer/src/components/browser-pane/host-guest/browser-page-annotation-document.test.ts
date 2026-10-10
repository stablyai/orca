// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserMockApi, createTestStore } from '@/store/slices/browser-slice-test-harness'
import { makeAnnotation } from '@/store/slices/browser-annotation-test-fixture'
import { syncGuestAnnotationViewportBridge } from '../annotate/guest-annotation-viewport-bridge'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'
import { createBrowserPageWebviewNavigationHandlers } from './browser-page-webview-navigation-handlers'

afterEach(() => vi.unstubAllGlobals())

function createHarness() {
  const setAnnotationViewportBridge = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      ...createBrowserMockApi(vi.fn()),
      browser: { ...createBrowserMockApi(vi.fn()).browser, setAnnotationViewportBridge }
    }
  })
  const store = createTestStore()
  const pageId = store.getState().createBrowserTab('wt-1', 'https://example.com').activePageId
  if (!pageId) {
    throw new Error('Expected browser page')
  }
  store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
  const ref = <T>(current: T) => ({ current })
  const cancelCapture = vi.fn()
  const setBrowserOverlayViewport = vi.fn()
  const url = ref<string | null>('https://example.com/')
  const webviewFixture = {
    getURL: () => url.current ?? '',
    getTitle: () => 'Example',
    canGoBack: () => false,
    canGoForward: () => false,
    src: 'https://example.com/'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these factories only use the guest methods explicitly supplied by this fixture.
  const webview = webviewFixture as unknown as Electron.WebviewTag
  const invalidateBrowserAnnotationDocumentRef = ref(() => {
    store.getState().invalidateBrowserPageAnnotationGeometry(pageId)
    cancelCapture()
    syncGuestAnnotationViewportBridge({
      toolTargetId: pageId,
      annotations: store.getState().browserAnnotationsByPageId[pageId],
      currentDocument: {
        markerIds: store.getState().browserAnnotationMarkerIdsByPageId[pageId] ?? [],
        url: url.current ?? ''
      },
      pendingPayload: null,
      surfaceActive: true,
      token: 'token'
    })
  })
  const common = {
    webview,
    browserTabId: pageId,
    faviconUrlRef: ref<string | null>(null),
    addressBarInputRef: ref<HTMLInputElement | null>(null),
    activeLoadFailureRef: ref(null),
    lastKnownWebviewUrlRef: url,
    recoveryNavigationValidationRef: ref(null),
    invalidateBrowserAnnotationDocumentRef,
    onUpdatePageStateRef: ref(vi.fn()),
    onSetUrlRef: ref((id: string, nextUrl: string) =>
      store.getState().setBrowserPageUrl(id, nextUrl)
    ),
    setBrowserOverlayViewport,
    setAddressBarValueFromPage: vi.fn()
  }
  const loading = createBrowserPageWebviewLoadingHandlers({
    ...common,
    browserTabUrlRef: ref('https://example.com/'),
    addressBarValueRef: ref('https://example.com/'),
    trackNextLoadingEventRef: ref(false),
    keepAddressBarFocusRef: ref(false),
    focusAddressBarNow: () => false
  })
  const navigation = createBrowserPageWebviewNavigationHandlers({
    ...common,
    browserTabUrl: 'https://example.com/',
    addBrowserHistoryEntryRef: ref(vi.fn()),
    annotationViewportBridgeTokenRef: ref('token')
  })
  return {
    store,
    pageId,
    loading,
    navigation,
    cancelCapture,
    setAnnotationViewportBridge,
    setBrowserOverlayViewport
  }
}

function navigationEvent(
  url: string,
  isInPlace = false,
  isMainFrame = true
): Electron.DidStartNavigationEvent {
  return Object.assign(new Event('did-start-navigation'), {
    url,
    isInPlace,
    isMainFrame,
    frameProcessId: 1,
    frameRoutingId: 1
  })
}

describe('browser annotation document boundaries', () => {
  it('retains the exact saved notes on actual same-URL loading-start, including untracked loads', () => {
    const h = createHarness()
    const saved = h.store.getState().browserAnnotationsByPageId[h.pageId]
    h.loading.handleDidStartLoading()
    expect(h.store.getState().browserAnnotationsByPageId[h.pageId]).toBe(saved)
    expect(h.store.getState().browserAnnotationMarkerIdsByPageId[h.pageId]).toBeUndefined()
    expect(h.cancelCapture).toHaveBeenCalledOnce()
    expect(h.setBrowserOverlayViewport).toHaveBeenCalledWith({ scrollX: 0, scrollY: 0, version: 0 })
    expect(h.setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, emitViewport: false, markers: [] })
    )
  })

  it('retires geometry for full and same-document main-frame navigation but not subframes', () => {
    const h = createHarness()
    h.navigation.handleDidStartNavigation(
      navigationEvent('https://example.com/frame', false, false)
    )
    expect(h.cancelCapture).not.toHaveBeenCalled()
    h.navigation.handleDidStartNavigation(navigationEvent('https://example.com/#new', true))
    expect(h.cancelCapture).toHaveBeenCalledOnce()
    h.store.getState().addBrowserPageAnnotation(makeAnnotation(h.pageId, 'fresh'))
    h.navigation.handleDidStartNavigation(navigationEvent('https://example.com/next'))
    expect(h.cancelCapture).toHaveBeenCalledTimes(2)
    expect(h.store.getState().browserAnnotationsByPageId[h.pageId]).toHaveLength(2)
    expect(h.store.getState().browserAnnotationMarkerIdsByPageId[h.pageId]).toBeUndefined()
  })

  it('keeps geometry retired after redirects and away/back commits, including missed start events', () => {
    const h = createHarness()
    const saved = h.store.getState().browserAnnotationsByPageId[h.pageId]
    h.loading.handleDidStartLoading()
    h.navigation.handleDidRedirectNavigation(navigationEvent('https://example.org/redirect'))
    h.navigation.handleFullDidNavigate({ url: 'https://example.org/redirect', isMainFrame: true })
    h.navigation.handleFullDidNavigate({ url: 'https://example.com/', isMainFrame: true })
    expect(h.store.getState().browserAnnotationsByPageId[h.pageId]).toBe(saved)
    expect(h.store.getState().browserAnnotationMarkerIdsByPageId[h.pageId]).toBeUndefined()
    h.store.getState().addBrowserPageAnnotation(makeAnnotation(h.pageId, 'fresh'))
    h.navigation.handleDidNavigateInPage({ url: 'https://example.com/#another', isMainFrame: true })
    expect(h.store.getState().browserAnnotationMarkerIdsByPageId[h.pageId]).toBeUndefined()
  })
})
