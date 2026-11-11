// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { AttachBrowserPageWebviewArgs } from './attach-browser-page-webview'

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
  isBrowserPageRendererRecoveryPending: () => false,
  moveFocusToRendererBeforeWebviewDetach() {}
}))
vi.mock('./browser-page-viewport', () => ({ parkBrowserPageViewport() {} }))
vi.mock('./browser-system-resume', () => ({ subscribeBrowserSystemResume: () => () => {} }))
vi.mock('../annotate/browser-annotation-viewport-message', () => ({
  consumeBrowserAnnotationViewportMessage() {}
}))

import { useAppStore } from '@/store'
import { bindBrowserPageWebviewListeners } from './bind-browser-page-webview-listeners'
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

function mount(state: BrowserGuestMetadata) {
  const ref = <T>(current: T) => ({ current })
  const first: BrowserPage = {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'https://example.test/attempted',
    title: 'Saved title',
    loading: false,
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM guest with the native identity used by production cache, no synchronous metadata methods.
  const webview = Object.assign(document.createElement('webview'), {
    getWebContentsId: () => 42
  }) as Electron.WebviewTag
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
    addBrowserHistoryEntryRef: ref(() => {}),
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
    webview,
    dispose,
    page: () => useAppStore.getState().browserPagesByWorkspace['workspace-a'][0]
  }
}

describe('mounted browser metadata application', () => {
  it('keeps the saved title before the first document commits', () => {
    const view = mount(nativeState({ navigationRevision: 0, url: '', title: '' }))
    expect(view.page().title).toBe('Saved title')
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
