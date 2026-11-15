// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserGuestMetadata } from '../../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type {
  BrowserPage,
  BrowserWorkspace
} from '../../../../../../shared/browser-workspace-types'
import type { AttachBrowserPageWebviewArgs } from '../lifecycle/attach-browser-page-webview'

const adapters = vi.hoisted(() => ({ ensureViewport: vi.fn(), ensureWebview: vi.fn() }))

vi.mock('@/components/native-chat/media/visuals/NativeChatVisualGuestThemePublisher', () => ({
  publishNativeChatVisualGuestTheme: () => {}
}))
vi.mock('../lifecycle/browser-page-webview-guest-session', () => ({
  createBrowserPageWebviewGuestSession: () => ({
    guestRecovery: { validateAfterResume() {}, retryRecovery() {}, dispose() {} },
    handleDidAttach() {},
    handleDomReady() {},
    handleGuestDestroyed() {}
  })
}))
vi.mock('../webview-registry', () => ({
  isBrowserPageRendererRecoveryPending: () => false,
  moveFocusToRendererBeforeWebviewDetach() {}
}))
vi.mock('../viewport/browser-page-viewport', () => ({
  parkBrowserPageViewport() {},
  applyBrowserPageViewportLayout() {},
  syncBrowserPageChromeInset() {},
  ensureBrowserPageViewport: adapters.ensureViewport
}))
vi.mock('../lifecycle/browser-page-webview', () => ({
  ensureBrowserPageWebview: adapters.ensureWebview
}))
vi.mock('../recovery/browser-system-resume', () => ({
  subscribeBrowserSystemResume: () => () => {}
}))
vi.mock('../../annotate/viewport/browser-annotation-viewport-message', () => ({
  consumeBrowserAnnotationViewportMessage() {}
}))

import { useAppStore } from '@/store/index'
import { bindBrowserPageWebviewListeners } from '../lifecycle/bind-browser-page-webview-listeners'
import {
  acceptBrowserGuestMetadata,
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
  const history = vi.fn()
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
})
