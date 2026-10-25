// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../../../shared/browser-annotation-viewport-bridge'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi } from '@/store/slices/browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from '@/store/slices/browser-slice-drawn-from-main.test-fixture'
import { makeAnnotation } from '@/store/slices/browser-annotation-test-fixture'
import { syncGuestAnnotationViewportBridge } from '../annotate/guest-annotation-viewport-bridge'
import { createBrowserPageWebviewLoadingHandlers } from './browser-page-webview-loading-handlers'
import { createBrowserPageWebviewNavigationHandlers } from './browser-page-webview-navigation-handlers'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

afterEach(() => vi.unstubAllGlobals())

async function createHarness() {
  const setAnnotationViewportBridge = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      ...createBrowserMockApi(vi.fn()),
      browser: { ...createBrowserMockApi(vi.fn()).browser, setAnnotationViewportBridge }
    }
  })
  const { store, main } = await createTestStoreDrawnFromMain()
  const pageId = store.getState().createBrowserTab('wt-1', 'https://example.com').activePageId
  await main.settle()
  if (!pageId) {
    throw new Error('Expected browser page')
  }
  // A layout-owner build's main opened the page's tab, and its frame drew the page.
  expect(layoutApplyTestTransport.sentOfType('openBrowserTab')).toEqual(
    ORCA_LAYOUT_OWNER_IS_MAIN ? [expect.objectContaining({ pageId })] : []
  )
  expect(Object.values(store.getState().browserPagesByWorkspace).flat()).toEqual([
    expect.objectContaining({ id: pageId })
  ])
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
    setAddressBarValue: vi.fn()
  }
  const loading = createBrowserPageWebviewLoadingHandlers({
    ...common,
    browserTabUrlRef: ref('https://example.com/'),
    addressBarValueRef: ref('https://example.com/'),
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
  it('still accepts token-authenticated live target reports', async () => {
    const h = await createHarness()
    const report = JSON.stringify({
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 900,
      target: { x: 40, y: 120, width: 120, height: 30 }
    })
    h.navigation.handleAnnotationViewportMessage({
      message: `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}wrong:${report}`
    })
    expect(h.setBrowserOverlayViewport).not.toHaveBeenCalled()

    h.navigation.handleAnnotationViewportMessage({
      message: `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}token:${report}`
    })
    expect(h.setBrowserOverlayViewport).toHaveBeenCalledOnce()
    expect(
      h.setBrowserOverlayViewport.mock.calls[0][0]({ scrollX: 0, scrollY: 0, version: 0 })
    ).toEqual({
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 900,
      target: { x: 40, y: 120, width: 120, height: 30 },
      version: 1
    })
  })

  it('retains the exact saved notes on actual same-URL loading-start, including untracked loads', async () => {
    const h = await createHarness()
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

  it('retires geometry for full and same-document main-frame navigation but not subframes', async () => {
    const h = await createHarness()
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

  it('keeps geometry retired after redirects and away/back commits, including missed start events', async () => {
    const h = await createHarness()
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
