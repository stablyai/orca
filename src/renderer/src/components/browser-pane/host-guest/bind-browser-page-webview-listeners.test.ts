// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { bindBrowserPageWebviewListeners } from './bind-browser-page-webview-listeners'
import {
  clearBrowserPageProgress,
  recordBrowserPageProgress
} from './browser-page-progress-retention'
import type { AttachBrowserPageWebviewArgs } from './attach-browser-page-webview'

describe('bindBrowserPageWebviewListeners progress restoration', () => {
  const browserTabId = 'tab-restore-test'

  beforeEach(() => {
    clearBrowserPageProgress(browserTabId)
    ;(window as unknown as { api: unknown }).api = {
      ui: { onSystemResumed: vi.fn(() => vi.fn()) },
      browser: {
        registerGuest: vi.fn().mockResolvedValue(true),
        isGuestRegistered: vi.fn().mockResolvedValue(true),
        setViewportOverride: vi.fn().mockResolvedValue(true)
      }
    }
  })

  function createMockArgs(): AttachBrowserPageWebviewArgs {
    return {
      browserTabId,
      browserTabUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
      sessionProfileId: null,
      webviewPartition: 'persist:test',
      isActive: true,
      isPaintable: true,
      inputLockedRef: { current: false },
      webviewRef: { current: null },
      handleInternalFileDragOverRef: { current: vi.fn() },
      handleInternalFileDropRef: { current: vi.fn() },
      dismissAddressBarSuggestionsRef: { current: vi.fn() },
      isPaintableRef: { current: true },
      guestRecoveryPendingRef: { current: false },
      browserTabUrlRef: { current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      addressBarValueRef: { current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      activeLoadFailureRef: { current: null },
      recoveryNavigationValidationRef: { current: null },
      keepAddressBarFocusRef: { current: false },
      paneZoomLevelRef: { current: 1 },
      viewportPresetIdRef: { current: null },
      onUpdatePageStateRef: { current: vi.fn() },
      setGuestRecoveryGeneration: vi.fn(),
      setBrowserZoomPercent: vi.fn(),
      focusAddressBarNow: vi.fn(() => true),
      syncNavigationState: vi.fn(),
      syncBrowserAnnotationViewportBridge: vi.fn(),
      faviconUrlRef: { current: null },
      addressBarInputRef: { current: null },
      lastKnownWebviewUrlRef: { current: null },
      trackNextLoadingEventRef: { current: false },
      clearBrowserPageAnnotationsRef: { current: vi.fn() },
      onSetUrlRef: { current: vi.fn() },
      setPendingAnnotationPayload: vi.fn(),
      setBrowserOverlayViewport: vi.fn(),
      setAddressBarValue: vi.fn(),
      addBrowserHistoryEntryRef: { current: vi.fn() },
      annotationViewportBridgeTokenRef: { current: 'token-123' },
      initialBrowserUrlRef: { current: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      validateVisibleGuestRegistrationRef: { current: vi.fn() },
      retryGuestRecoveryRef: { current: vi.fn() },
      setFindOpen: vi.fn()
    }
  }

  function createMockWebview() {
    const listeners = new Map<string, Set<EventListener>>()
    return {
      src: '',
      getURL: vi.fn(() => 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      getTitle: vi.fn(() => 'Test Video'),
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      getWebContentsId: vi.fn(() => 42),
      contains: vi.fn(() => false),
      executeJavaScript: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((event: string, cb: EventListener) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set())
        }
        listeners.get(event)!.add(cb)
      }),
      removeEventListener: vi.fn((event: string, cb: EventListener) => {
        listeners.get(event)?.delete(cb)
      }),
      dispatchMockEvent(event: string) {
        for (const cb of listeners.get(event) ?? []) {
          cb({} as Event)
        }
      }
    } as unknown as Electron.WebviewTag & { dispatchMockEvent: (event: string) => void }
  }

  it('navigates to restored YouTube URL with playback timestamp and restores on dom-ready', () => {
    recordBrowserPageProgress(browserTabId, {
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      scrollX: 0,
      scrollY: 100,
      media: {
        currentTime: 85.5,
        paused: false,
        playbackRate: 1
      },
      timestamp: Date.now()
    })

    const webview = createMockWebview()
    const container = document.createElement('div')
    const args = createMockArgs()

    const unbind = bindBrowserPageWebviewListeners({
      container,
      webview,
      needsInitialNavigation: true,
      onContainerDragOver: vi.fn(),
      onContainerDrop: vi.fn(),
      dismissAddressBarSuggestions: vi.fn(),
      args
    })

    // Expect src to contain &t=85s
    expect(webview.src).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=85s')

    // Simulate dom-ready
    webview.dispatchMockEvent('dom-ready')

    expect(webview.executeJavaScript).toHaveBeenCalled()
    const script = vi.mocked(webview.executeJavaScript).mock.calls[0][0] as string
    expect(script).toContain('media.currentTime = targetTime')

    unbind?.()
  })

  it('uses default initial URL when no saved progress is present', () => {
    const webview = createMockWebview()
    const container = document.createElement('div')
    const args = createMockArgs()

    const unbind = bindBrowserPageWebviewListeners({
      container,
      webview,
      needsInitialNavigation: true,
      onContainerDragOver: vi.fn(),
      onContainerDrop: vi.fn(),
      dismissAddressBarSuggestions: vi.fn(),
      args
    })

    expect(webview.src).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    unbind?.()
  })
})
