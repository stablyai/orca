import {
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
import { useAppStore } from '@/store/index'
import type {
  BrowserLoadError,
  BrowserViewportPresetId
} from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import type { BrowserGuestAnnotationViewportBridge } from '../annotate/use-browser-guest-annotate-tools'
import { attachBrowserPageWebview } from './lifecycle/attach-browser-page-webview'
import { webviewRegistry } from './webview-registry'
import { setBrowserPageWebviewInputLock } from './lifecycle/browser-page-webview'
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
  isMountAdmitted,
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
  annotationViewportBridge,
  setBrowserOverlayViewport,
  setFindOpen,
  focusAddressBarNow,
  focusWebviewNow,
  inputLocked,
  faviconUrl,
  webviewRef,
  lastKnownWebviewUrlRef,
  recoveryNavigationValidationRef,
  activeLoadFailureRef,
  retryGuestRecoveryRef,
  onUpdatePageStateRef,
  onSetUrlRef
}: {
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
  isMountAdmitted: boolean
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
  annotationViewportBridge: BrowserGuestAnnotationViewportBridge
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  setFindOpen: Dispatch<SetStateAction<boolean>>
  focusAddressBarNow: () => boolean
  focusWebviewNow: () => boolean
  inputLocked: boolean
  faviconUrl: string | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
}): void {
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
  const {
    tokenRef: annotationViewportBridgeTokenRef,
    sync: syncBrowserAnnotationViewportBridge,
    invalidateDocument: invalidateBrowserAnnotationDocument
  } = annotationViewportBridge

  useLayoutEffect(() => {
    inputLockedRef.current = inputLocked
    viewportPresetIdRef.current = viewportPresetId
    isPaintableRef.current = isPaintable
  }, [inputLocked, isPaintable, viewportPresetId])

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

  const invalidateBrowserAnnotationDocumentRef = useRef(invalidateBrowserAnnotationDocument)
  useLayoutEffect(() => {
    invalidateBrowserAnnotationDocumentRef.current = invalidateBrowserAnnotationDocument
  }, [invalidateBrowserAnnotationDocument])

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
      viewportPresetIdRef,
      onUpdatePageStateRef,
      setGuestRecoveryGeneration,
      focusAddressBarNow,
      syncBrowserAnnotationViewportBridge,
      faviconUrlRef,
      addressBarInputRef,
      lastKnownWebviewUrlRef,
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
    // Exclude URL changes to avoid cancelling navigation; callbacks read refs. Include partition changes because Electron requires a new guest.
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
    syncBrowserAnnotationViewportBridge
  ])

  useEffect(() => {
    const becamePaintable = isPaintable && !wasPaintableForGuestValidationRef.current
    wasPaintableForGuestValidationRef.current = isPaintable
    if ((isPaintable || isMountAdmitted) && !webviewRegistry.has(browserTabId)) {
      setGuestRecoveryGeneration((generation) => generation + 1)
    } else if (becamePaintable) {
      validateVisibleGuestRegistrationRef.current()
    }
  }, [browserTabId, isPaintable, isMountAdmitted])
}
