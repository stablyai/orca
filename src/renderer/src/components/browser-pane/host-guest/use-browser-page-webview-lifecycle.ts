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
import { useAppStore } from '@/store'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type {
  BrowserLoadError,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import { syncBrowserPageNavigationState } from './browser-page-navigation-source'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { useBrowserPageAnnotationViewport } from '../annotate/use-browser-page-annotation-viewport'
import { attachBrowserPageWebview } from './attach-browser-page-webview'
import { setBrowserPageWebviewInputLock } from './browser-page-webview'
import type {
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export function useBrowserPageWebviewLifecycle({
  enabled = true,
  browserTabId,
  browserTabUrl,
  browserTabLoading,
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
  cancelPendingBrowserCapture,
  setBrowserOverlayViewport,
  setFindOpen,
  focusAddressBarNow,
  focusWebviewNow,
  paneZoomLevelRef,
  setBrowserZoomPercent,
  pendingAnnotationPayload,
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
  enabled?: boolean
  browserTabId: string
  browserTabUrl: string
  browserTabLoading: boolean
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
  cancelPendingBrowserCapture: () => void
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  setFindOpen: Dispatch<SetStateAction<boolean>>
  focusAddressBarNow: () => boolean
  focusWebviewNow: () => boolean
  paneZoomLevelRef: MutableRefObject<number>
  setBrowserZoomPercent: Dispatch<SetStateAction<number>>
  pendingAnnotationPayload: BrowserGrabPayload | null
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
  invalidateBrowserAnnotationDocumentRef: MutableRefObject<() => void>
  annotationViewportBridgeTokenRef: MutableRefObject<string>
} {
  const [guestRecoveryGeneration, setGuestRecoveryGeneration] = useState(0)
  const guestRecoveryPendingRef = useRef(false)
  const validateVisibleGuestRegistrationRef = useRef<() => void>(() => {})
  const wasPaintableForGuestValidationRef = useRef(isPaintable)
  const browserTabLoadingRef = useRef(browserTabLoading)
  const inputLockedRef = useRef(inputLocked)
  const faviconUrlRef = useRef<string | null>(faviconUrl)
  const initialBrowserUrlRef = useRef(browserTabUrl)
  // Why: CDP viewport emulation doesn't survive renderer process swaps, so reapply the preset from this ref on every dom-ready.
  const viewportPresetIdRef = useRef(viewportPresetId)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const addBrowserHistoryEntryRef = useRef(addBrowserHistoryEntry)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const isPaintableRef = useRef(isPaintable)
  const {
    annotationViewportBridgeTokenRef,
    invalidateBrowserAnnotationDocumentRef,
    syncBrowserAnnotationViewportBridge
  } = useBrowserPageAnnotationViewport({
    browserTabId,
    browserTabUrl,
    browserTabUrlRef,
    isActive,
    pendingAnnotationPayload,
    cancelPendingBrowserCapture
  })

  useLayoutEffect(() => {
    browserTabLoadingRef.current = browserTabLoading
    inputLockedRef.current = inputLocked
    viewportPresetIdRef.current = viewportPresetId
    isPaintableRef.current = isPaintable
  }, [browserTabLoading, inputLocked, isPaintable, viewportPresetId])

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
    activeLoadFailureRef.current = browserTabLoadError
  }, [activeLoadFailureRef, browserTabLoadError])

  useEffect(() => {
    onUpdatePageStateRef.current = onUpdatePageState
    onSetUrlRef.current = onSetUrl
    addBrowserHistoryEntryRef.current = addBrowserHistoryEntry
  }, [onSetUrl, onUpdatePageState, addBrowserHistoryEntry, onSetUrlRef, onUpdatePageStateRef])

  const syncNavigationState = useCallback(
    (webview: Electron.WebviewTag): void => {
      syncBrowserPageNavigationState(
        webview,
        browserTabId,
        browserTabUrlRef.current,
        browserTabLoadingRef.current,
        onUpdatePageStateRef.current
      )
    },
    [browserTabId, browserTabUrlRef, onUpdatePageStateRef]
  )

  useEffect(() => {
    if (!enabled) {
      return
    }
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
      invalidateBrowserAnnotationDocumentRef,
      onSetUrlRef,
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
    enabled,
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
    if (enabled && becamePaintable) {
      validateVisibleGuestRegistrationRef.current()
    }
  }, [enabled, isPaintable])

  return {
    syncBrowserAnnotationViewportBridge,
    invalidateBrowserAnnotationDocumentRef,
    annotationViewportBridgeTokenRef
  }
}
