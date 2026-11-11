// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { AttachBrowserPageWebviewArgs } from './attach-browser-page-webview'

const adapters = vi.hoisted(() => ({ ensureViewport: vi.fn(), ensureWebview: vi.fn() }))

vi.mock('@/components/native-chat/media/visuals/NativeChatVisualGuestThemePublisher', () => ({
  publishNativeChatVisualGuestTheme: () => {}
}))
vi.mock('./browser-page-webview-guest-session', () => ({
  createBrowserPageWebviewGuestSession: () => ({
    guestRecovery: { validateAfterResume() {}, retryRecovery() {}, dispose() {} },
    handleDidAttach() {},
    handleDomReady() {},
    handleGuestDestroyed() {}
  })
}))
vi.mock('./webview-registry', () => ({
  webviewRegistry: new Map(),
  isBrowserPageRendererRecoveryPending: () => false,
  moveFocusToRendererBeforeWebviewDetach() {}
}))
vi.mock('./browser-page-viewport', () => ({
  parkBrowserPageViewport() {},
  applyBrowserPageViewportLayout() {},
  syncBrowserPageChromeInset() {},
  ensureBrowserPageViewport: adapters.ensureViewport
}))
vi.mock('./browser-page-webview', () => ({ ensureBrowserPageWebview: adapters.ensureWebview }))
vi.mock('./browser-system-resume', () => ({ subscribeBrowserSystemResume: () => () => {} }))
vi.mock('../annotate/browser-annotation-viewport-message', () => ({
  consumeBrowserAnnotationViewportMessage() {}
}))

import { useAppStore } from '@/store'
import { webviewRegistry } from './webview-registry'
import { bindBrowserPageWebviewListeners } from './bind-browser-page-webview-listeners'
import { attachBrowserPageWebview } from './attach-browser-page-webview'
import { useBrowserPageWebviewUrlSync } from '../navigate/use-browser-page-webview-url-sync'
import {
  acceptBrowserGuestMetadata,
  cachedBrowserGuestMetadata,
  clearBrowserGuestMetadata
} from './browser-guest-metadata-cache'

const disposers: (() => void)[] = []
beforeEach(clearBrowserGuestMetadata)
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  clearBrowserGuestMetadata()
  webviewRegistry.clear()
  document.body.replaceChildren()
})

function nativeState(patch: Partial<BrowserGuestMetadata> = {}): BrowserGuestMetadata {
  return {
    browserPageId: 'page-a',
    webContentsId: 42,
    revision: 1,
    navigationRevision: 1,
    kind: 'snapshot',
    url: 'https://example.test/old',
    title: 'Saved title',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    errorPage: false,
    loadError: null,
    hasCertificateFailure: false,
    ...patch
  }
}

function mount(state: BrowserGuestMetadata, initiallyLoading = false) {
  const ref = <T>(current: T) => ({ current })
  const first: BrowserPage = {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'https://example.test/attempted',
    title: 'Saved title',
    loading: initiallyLoading,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: false,
    loadError: state.loadError,
    createdAt: 1
  }
  const pages = [first]
  const workspace: BrowserWorkspace = {
    ...first,
    id: 'workspace-a',
    activePageId: 'page-a',
    pageIds: pages.map((page) => page.id)
  }
  useAppStore.setState({
    browserPagesByWorkspace: { 'workspace-a': pages },
    browserTabsByWorktree: { 'worktree-a': [workspace] },
    unifiedTabsByWorktree: {}
  })
  const update = vi.fn(useAppStore.getState().updateBrowserPageState)
  const setUrl = vi.fn(useAppStore.getState().setBrowserPageUrl)
  const address = vi.fn()
  const history = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM guest with the native identity used by production cache, no synchronous metadata methods.
  const webview = Object.assign(document.createElement('webview'), {
    getWebContentsId: () => 42
  }) as Electron.WebviewTag
  webviewRegistry.set('page-a', webview)
  const container = document.createElement('div')
  container.append(webview)
  document.body.append(container)
  const args: AttachBrowserPageWebviewArgs = {
    browserTabId: 'page-a',
    browserTabUrl: first.url,
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    sessionProfileId: null,
    webviewPartition: '',
    isActive: false,
    isPaintable: false,
    inputLockedRef: ref(false),
    webviewRef: ref(webview),
    handleInternalFileDragOverRef: ref(() => {}),
    handleInternalFileDropRef: ref(() => {}),
    dismissAddressBarSuggestionsRef: ref(null),
    isPaintableRef: ref(false),
    guestRecoveryPendingRef: ref(false),
    browserTabUrlRef: ref(first.url),
    addressBarValueRef: ref(first.url),
    activeLoadFailureRef: ref(state.loadError),
    recoveryNavigationValidationRef: ref(null),
    keepAddressBarFocusRef: ref(false),
    viewportPresetIdRef: ref(null),
    onUpdatePageStateRef: ref(update),
    setGuestRecoveryGeneration: () => {},
    focusAddressBarNow: () => false,
    syncBrowserAnnotationViewportBridge: () => {},
    faviconUrlRef: ref(null),
    addressBarInputRef: ref(null),
    lastKnownWebviewUrlRef: ref(first.url),
    invalidateBrowserAnnotationDocumentRef: ref(() => {}),
    onSetUrlRef: ref(setUrl),
    setBrowserOverlayViewport: () => {},
    setAddressBarValue: address,
    addBrowserHistoryEntryRef: ref(history),
    annotationViewportBridgeTokenRef: ref('token'),
    initialBrowserUrlRef: ref(first.url),
    validateVisibleGuestRegistrationRef: ref(() => {}),
    retryGuestRecoveryRef: ref(() => {}),
    setFindOpen: () => {}
  }
  acceptBrowserGuestMetadata(state)
  const dispose = bindBrowserPageWebviewListeners({
    container,
    webview,
    needsInitialNavigation: false,
    onContainerDragOver: () => {},
    onContainerDrop: () => {},
    dismissAddressBarSuggestions: () => {},
    args
  })
  disposers.push(dispose)
  return {
    update,
    setUrl,
    address,
    history,
    args,
    container,
    webview,
    dispose,
    page: () => useAppStore.getState().browserPagesByWorkspace['workspace-a'][0]
  }
}

describe('mounted browser metadata application', () => {
  it.each([
    {
      kind: 'navigation' as const,
      oldUrl: 'https://example.test/held-redirect',
      currentUrl: 'https://example.test/b'
    },
    {
      kind: 'in-page' as const,
      oldUrl: 'https://example.test/a',
      currentUrl: 'https://example.test/a#hidden'
    }
  ])(
    'adopts a hidden $kind on attach without replaying the old request',
    ({ kind, oldUrl, currentUrl }) => {
      const view = mount(nativeState({ url: oldUrl }))
      view.dispose()
      acceptBrowserGuestMetadata(
        nativeState({ revision: 2, kind, url: currentUrl, title: 'Hidden destination' })
      )
      view.webview.setAttribute('src', currentUrl)
      const destinations: string[] = []
      Object.defineProperty(view.webview, 'src', {
        configurable: true,
        get: () => view.webview.getAttribute('src') ?? '',
        set: (url: string) => {
          destinations.push(url)
          view.webview.setAttribute('src', url)
        }
      })
      adapters.ensureViewport.mockReturnValue({
        container: view.container,
        content: view.container
      })
      adapters.ensureWebview.mockReturnValue({
        created: false,
        container: view.container,
        webview: view.webview
      })
      const mounted = renderHook(() => {
        const url = useAppStore(
          (state) => state.browserPagesByWorkspace['workspace-a']?.[0]?.url ?? ''
        )
        useEffect(() => {
          view.args.browserTabUrlRef.current = url
        }, [url])
        useEffect(() => attachBrowserPageWebview(view.args), [])
        useBrowserPageWebviewUrlSync({
          browserTabId: 'page-a',
          browserTabUrl: url,
          workspaceId: 'workspace-a',
          isActive: true,
          isPaintable: true,
          slotViewport: view.container,
          webviewRef: view.args.webviewRef,
          chromeHeaderRef: { current: null },
          lastKnownWebviewUrlRef: view.args.lastKnownWebviewUrlRef,
          keepAddressBarFocusRef: view.args.keepAddressBarFocusRef,
          addressBarInputRef: view.args.addressBarInputRef,
          focusWebviewNow: () => false
        })
      })
      disposers.push(mounted.unmount)
      expect(view.page()).toMatchObject({
        url: currentUrl,
        title: 'Hidden destination',
        loading: false
      })
      expect(view.address).toHaveBeenLastCalledWith(currentUrl)
      expect(destinations).toEqual([])

      act(() => useAppStore.getState().setBrowserPageUrl('page-a', 'https://example.test/next'))
      expect(destinations).toEqual(['https://example.test/next'])
      act(() => useAppStore.setState({ browserPagesByWorkspace: {} }))
      expect(destinations).toEqual(['https://example.test/next'])
    }
  )

  it('keeps an untitled document identifiable through title, Stop and retained replay', () => {
    const view = mount(
      nativeState({ url: 'https://kagi.com/search?token=test-only&q=orca', title: 'Results' })
    )
    acceptBrowserGuestMetadata(
      nativeState({
        revision: 2,
        kind: 'title',
        url: 'https://kagi.com/search?token=test-only&q=orca',
        title: '',
        loading: true
      })
    )
    expect(view.page().title).toBe('https://kagi.com/search?q=orca')
    expect(view.history).toHaveBeenLastCalledWith(
      'https://kagi.com/search?q=orca',
      'https://kagi.com/search?q=orca',
      null
    )
    acceptBrowserGuestMetadata(
      nativeState({
        revision: 3,
        kind: 'stop',
        url: 'https://kagi.com/search?token=test-only&q=orca',
        title: ''
      })
    )
    expect(view.page().title).toBe('https://kagi.com/search?q=orca')
    expect(useAppStore.getState().browserTabsByWorktree['worktree-a'][0].title).toBe(
      'https://kagi.com/search?q=orca'
    )
    view.dispose()
    const dispose = bindBrowserPageWebviewListeners({
      container: view.container,
      webview: view.webview,
      needsInitialNavigation: false,
      onContainerDragOver: () => {},
      onContainerDrop: () => {},
      dismissAddressBarSuggestions: () => {},
      args: view.args
    })
    disposers.push(dispose)
    expect(view.page().title).toBe('https://kagi.com/search?q=orca')
  })

  it('keeps the saved title before the first document commits', () => {
    const view = mount(nativeState({ navigationRevision: 0, url: '', title: '', loading: true }))
    expect(view.page().title).toBe('Saved title')
    expect(view.page().loading).toBe(true)
    acceptBrowserGuestMetadata(
      nativeState({
        revision: 2,
        navigationRevision: 0,
        kind: 'start',
        url: '',
        title: '',
        loading: true
      })
    )
    expect(view.page().title).toBe('Saved title')
    acceptBrowserGuestMetadata(
      nativeState({
        revision: 3,
        navigationRevision: 0,
        kind: 'stop',
        url: '',
        title: '',
        loading: false
      })
    )
    expect(view.page().title).toBe('Saved title')
    expect(view.page().url).toBe('https://example.test/attempted')
    expect(view.page().loading).toBe(false)
  })

  it('adopts a document that predates observation while native loading and saved loading are true', () => {
    const view = mount(
      nativeState({
        navigationRevision: 0,
        url: 'https://current.test/c',
        title: 'Current C',
        loading: true
      }),
      true
    )
    expect(view.page()).toMatchObject({
      url: 'https://current.test/c',
      title: 'Current C',
      loading: true
    })
  })

  it('reattaches a failed destination without replacing its address or clearing its certificate challenge', () => {
    const loadError = {
      code: -202,
      description: 'ERR_CERT_AUTHORITY_INVALID',
      validatedUrl: 'https://example.test/attempted'
    }
    const view = mount(nativeState({ loadError, hasCertificateFailure: true }))
    expect(view.setUrl).not.toHaveBeenCalled()
    expect(view.address).not.toHaveBeenCalled()
    expect(view.page().url).toBe('https://example.test/attempted')
    expect(view.page().loadError).toEqual(loadError)
    expect(view.page().canGoBack).toBe(true)
  })

  it('keeps parked titles out of saved page state and restores the current title on reattach', () => {
    const view = mount(nativeState())
    acceptBrowserGuestMetadata(nativeState({ revision: 2, kind: 'title', title: 'Next title' }))
    expect(view.page().title).toBe('Next title')
    view.dispose()
    acceptBrowserGuestMetadata(nativeState({ revision: 3, kind: 'title', title: 'Parked title' }))
    expect(view.page().title).toBe('Next title')
    expect(cachedBrowserGuestMetadata(view.webview)?.title).toBe('Parked title')
    const reattached = mount(nativeState({ revision: 4, title: 'Parked title' }))
    expect(reattached.page().title).toBe('Parked title')
  })
})
