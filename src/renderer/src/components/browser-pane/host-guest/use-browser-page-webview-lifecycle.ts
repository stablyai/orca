import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type {
  BrowserLoadError,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import { getBrowserDisplayTitle } from '../describe-page/browser-page-url-display'
import {
  EMPTY_BROWSER_ANNOTATIONS,
  type BrowserOverlayViewport
} from '../describe-page/browser-annotation-geometry'
import { attachBrowserPageWebview } from './attach-browser-page-webview'
import { setBrowserPageWebviewInputLock } from './browser-page-webview'
import type {
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export function useBrowserPageWebviewLifecycle({
  browserTabId,
  browserTabUrl,
  browserTabLoadError,
  workspaceId,
  worktreeId,
  sessionProfileId,
  webviewPartition,
  isActive,
  isPaintable,
  slotViewport,
  viewportPresetId,
  addressBarInputRef,
  addressBarValueRef,
  browserTabUrlRef,
  keepAddressBarFocusRef,
  handleInternalFileDragOverRef,
  handleInternalFileDropRef,
  dismissAddressBarSuggestionsRef,
  onUpdatePageState,
  onSetUrl,
  setAddressBarValue,
  setPendingAnnotationPayload,
  setBrowserOverlayViewport,
  setFindOpen,
  focusAddressBarNow,
  focusWebviewNow,
  paneZoomLevelRef,
  setBrowserZoomPercent,
  pendingAnnotationPayload,
  browserAnnotationsLength,
  inputLocked,
  faviconUrl,
  webviewRef,
  lastKnownWebviewUrlRef,
  trackNextLoadingEventRef,
  recoveryNavigationValidationRef,
  activeLoadFailureRef,
  retryGuestRecoveryRef,
  onUpdatePageStateRef,
  onSetUrlRef
}: {
  browserTabId: string
  browserTabUrl: string
  browserTabLoadError: BrowserLoadError | null
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  webviewPartition: string
  isActive: boolean
  isPaintable: boolean
  slotViewport: HTMLDivElement | null
  viewportPresetId: BrowserViewportPresetId | null
  addressBarInputRef: RefObject<HTMLInputElement | null>
  addressBarValueRef: MutableRefObject<string>
  browserTabUrlRef: MutableRefObject<string>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  handleInternalFileDragOverRef: MutableRefObject<(event: DragEvent<HTMLDivElement>) => void>
  handleInternalFileDropRef: MutableRefObject<(event: DragEvent<HTMLDivElement>) => void>
  dismissAddressBarSuggestionsRef: MutableRefObject<(() => void) | null>
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: BrowserPageUrlSetter
  setAddressBarValue: Dispatch<SetStateAction<string>>
  setPendingAnnotationPayload: Dispatch<SetStateAction<BrowserGrabPayload | null>>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  setFindOpen: Dispatch<SetStateAction<boolean>>
  focusAddressBarNow: () => boolean
  focusWebviewNow: () => boolean
  paneZoomLevelRef: MutableRefObject<number>
  setBrowserZoomPercent: Dispatch<SetStateAction<number>>
  pendingAnnotationPayload: BrowserGrabPayload | null
  browserAnnotationsLength: number
  inputLocked: boolean
  faviconUrl: string | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  trackNextLoadingEventRef: MutableRefObject<boolean>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
}): {
  syncBrowserAnnotationViewportBridge: () => void
} {
  const [guestRecoveryGeneration, setGuestRecoveryGeneration] = useState(0)
  const guestRecoveryPendingRef = useRef(false)
  const validateVisibleGuestRegistrationRef = useRef<() => void>(() => {})
  const wasPaintableForGuestValidationRef = useRef(isPaintable)
  const inputLockedRef = useRef(inputLocked)
  const faviconUrlRef = useRef<string | null>(faviconUrl)
  const initialBrowserUrlRef = useRef(browserTabUrl)
  // Why: CDP viewport emulation doesn't survive renderer process swaps, so reapply the preset from this ref on every dom-ready.
  const viewportPresetIdRef = useRef(viewportPresetId)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const addBrowserHistoryEntryRef = useRef(addBrowserHistoryEntry)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const isPaintableRef = useRef(isPaintable)
  const annotationViewportBridgeTokenRef = useRef(createBrowserUuid().replaceAll('-', ''))
  const isActiveRef = useRef(isActive)
  const pendingAnnotationPayloadRef = useRef(pendingAnnotationPayload)
  const browserAnnotations = useAppStore(
    (s) => s.browserAnnotationsByPageId[browserTabId] ?? EMPTY_BROWSER_ANNOTATIONS
  )
  const browserAnnotationsRef = useRef(browserAnnotations)
  const clearBrowserPageAnnotations = useAppStore((s) => s.clearBrowserPageAnnotations)
  const clearBrowserPageAnnotationsRef = useRef(clearBrowserPageAnnotations)

  useLayoutEffect(() => {
    inputLockedRef.current = inputLocked
    viewportPresetIdRef.current = viewportPresetId
    isActiveRef.current = isActive
    pendingAnnotationPayloadRef.current = pendingAnnotationPayload
    browserAnnotationsRef.current = browserAnnotations
    clearBrowserPageAnnotationsRef.current = clearBrowserPageAnnotations
    isPaintableRef.current = isPaintable
  }, [
    browserAnnotations,
    clearBrowserPageAnnotations,
    inputLocked,
    isActive,
    isPaintable,
    pendingAnnotationPayload,
    viewportPresetId
  ])

  useLayoutEffect(() => {
    const webview = webviewRef.current
    if (webview) {
      setBrowserPageWebviewInputLock(webview, inputLocked)
    }
  }, [inputLocked, webviewRef])

  useEffect(() => {
    initialBrowserUrlRef.current = browserTabUrl
  }, [browserTabId, browserTabUrl])

  useEffect(() => {
    browserTabUrlRef.current = browserTabUrl
  }, [browserTabUrl, browserTabUrlRef])

  useEffect(() => {
    activeLoadFailureRef.current = browserTabLoadError
  }, [activeLoadFailureRef, browserTabLoadError])

  useEffect(() => {
    onUpdatePageStateRef.current = onUpdatePageState
    onSetUrlRef.current = onSetUrl
    addBrowserHistoryEntryRef.current = addBrowserHistoryEntry
  }, [onSetUrl, onUpdatePageState, addBrowserHistoryEntry, onSetUrlRef, onUpdatePageStateRef])

  const syncNavigationState = useCallback(
    (webview: Electron.WebviewTag): void => {
      try {
        onUpdatePageStateRef.current(browserTabId, {
          title: getBrowserDisplayTitle(
            webview.getTitle(),
            webview.getURL() || browserTabUrlRef.current
          ),
          // Why: attach can transiently report isLoading() with no real navigation; syncing it would flash the loading dot on tab switches.
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward()
        })
      } catch {
        // Why: these getters only exist after the guest fully attaches; ignore the transient failure during attach.
      }
    },
    [browserTabId, browserTabUrlRef, onUpdatePageStateRef]
  )

  const syncBrowserAnnotationViewportBridge = useCallback((): void => {
    const pendingPayload = pendingAnnotationPayloadRef.current
    // Why: existing badges render in-guest for smooth scroll; only the pending dialog needs viewport messages.
    const markers = browserAnnotationsRef.current.map((annotation, index) => ({
      id: annotation.id,
      index,
      isFixed: annotation.payload.target.isFixed === true,
      rectPage: annotation.payload.target.rectPage,
      rectViewport: annotation.payload.target.rectViewport
    }))
    const enabled = isActiveRef.current && (pendingPayload !== null || markers.length > 0)
    void window.api.browser
      .setAnnotationViewportBridge({
        browserPageId: browserTabId,
        emitViewport: pendingPayload !== null,
        enabled,
        markers,
        token: annotationViewportBridgeTokenRef.current
      })
      .catch(() => {
        // The viewport bridge is visual-only; stale markers beat breaking the pane on a destroyed guest.
      })
  }, [browserTabId])

  // Why: browserTab.url excluded from deps (changes every navigation → would destroy/recreate the webview); URL logic reads browserTabUrlRef.
  useEffect(() => {
    return attachBrowserPageWebview({
      browserTabId,
      browserTabUrl,
      workspaceId,
      worktreeId,
      sessionProfileId,
      webviewPartition,
      isActive,
      isPaintable,
      inputLockedRef,
      webviewRef,
      handleInternalFileDragOverRef,
      handleInternalFileDropRef,
      dismissAddressBarSuggestionsRef,
      isPaintableRef,
      guestRecoveryPendingRef,
      browserTabUrlRef,
      addressBarValueRef,
      activeLoadFailureRef,
      recoveryNavigationValidationRef,
      keepAddressBarFocusRef,
      paneZoomLevelRef,
      viewportPresetIdRef,
      onUpdatePageStateRef,
      setGuestRecoveryGeneration,
      setBrowserZoomPercent,
      focusAddressBarNow,
      syncNavigationState,
      syncBrowserAnnotationViewportBridge,
      faviconUrlRef,
      addressBarInputRef,
      lastKnownWebviewUrlRef,
      trackNextLoadingEventRef,
      clearBrowserPageAnnotationsRef,
      onSetUrlRef,
      setPendingAnnotationPayload,
      setBrowserOverlayViewport,
      setAddressBarValue,
      addBrowserHistoryEntryRef,
      annotationViewportBridgeTokenRef,
      initialBrowserUrlRef,
      validateVisibleGuestRegistrationRef,
      retryGuestRecoveryRef,
      setFindOpen
    })
    // Why: wire listeners once per tab identity. browserTab.url is excluded (re-running would detach/reattach and cancel navigations; callbacks use refs).
    // webviewPartition IS included: Electron can't change a webview's partition after creation, so a profile switch must recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    browserTabId,
    guestRecoveryGeneration,
    workspaceId,
    slotViewport,
    webviewPartition,
    worktreeId,
    createBrowserTab,
    focusAddressBarNow,
    focusWebviewNow,
    syncNavigationState,
    syncBrowserAnnotationViewportBridge
  ])

  useEffect(() => {
    const becamePaintable = isPaintable && !wasPaintableForGuestValidationRef.current
    wasPaintableForGuestValidationRef.current = isPaintable
    if (becamePaintable) {
      validateVisibleGuestRegistrationRef.current()
    }
  }, [isPaintable])

  useEffect(() => {
    syncBrowserAnnotationViewportBridge()
  }, [
    browserAnnotationsLength,
    browserTabId,
    isActive,
    pendingAnnotationPayload,
    syncBrowserAnnotationViewportBridge
  ])

  return {
    syncBrowserAnnotationViewportBridge
  }
}
