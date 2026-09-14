import type { Dispatch, DragEvent, MutableRefObject, RefObject, SetStateAction } from 'react'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import type {
  BrowserLoadError,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import { ensureBrowserPageWebview } from './browser-page-webview'
import { applyBrowserPageViewportLayout, ensureBrowserPageViewport } from './browser-page-viewport'
import { seedLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { bindBrowserPageWebviewListeners } from './bind-browser-page-webview-listeners'
import type {
  BrowserPageRecoveryNavigationValidation,
  BrowserPageUrlSetter,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export type AttachBrowserPageWebviewArgs = {
  browserTabId: string
  browserTabUrl: string
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  webviewPartition: string
  isActive: boolean
  isPaintable: boolean
  inputLockedRef: MutableRefObject<boolean>
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  handleInternalFileDragOverRef: MutableRefObject<(event: DragEvent<HTMLDivElement>) => void>
  handleInternalFileDropRef: MutableRefObject<(event: DragEvent<HTMLDivElement>) => void>
  dismissAddressBarSuggestionsRef: MutableRefObject<(() => void) | null>
  isPaintableRef: MutableRefObject<boolean>
  guestRecoveryPendingRef: MutableRefObject<boolean>
  browserTabUrlRef: MutableRefObject<string>
  addressBarValueRef: MutableRefObject<string>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  paneZoomLevelRef: MutableRefObject<number>
  viewportPresetIdRef: MutableRefObject<BrowserViewportPresetId | null>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  setGuestRecoveryGeneration: Dispatch<SetStateAction<number>>
  setBrowserZoomPercent: Dispatch<SetStateAction<number>>
  focusAddressBarNow: () => boolean
  syncNavigationState: (webview: Electron.WebviewTag) => void
  syncBrowserAnnotationViewportBridge: () => void
  faviconUrlRef: MutableRefObject<string | null>
  addressBarInputRef: RefObject<HTMLInputElement | null>
  lastKnownWebviewUrlRef: MutableRefObject<string | null>
  trackNextLoadingEventRef: MutableRefObject<boolean>
  clearBrowserPageAnnotationsRef: MutableRefObject<(pageId: string) => void>
  onSetUrlRef: MutableRefObject<BrowserPageUrlSetter>
  setPendingAnnotationPayload: Dispatch<SetStateAction<BrowserGrabPayload | null>>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  setAddressBarValue: Dispatch<SetStateAction<string>>
  addBrowserHistoryEntryRef: MutableRefObject<
    (url: string, title: string, faviconUrl?: string | null) => void
  >
  annotationViewportBridgeTokenRef: MutableRefObject<string>
  initialBrowserUrlRef: MutableRefObject<string>
  validateVisibleGuestRegistrationRef: MutableRefObject<() => void>
  retryGuestRecoveryRef: MutableRefObject<() => void>
  setFindOpen: Dispatch<SetStateAction<boolean>>
}

export function attachBrowserPageWebview(
  args: AttachBrowserPageWebviewArgs
): (() => void) | undefined {
  const {
    browserTabId,
    workspaceId,
    webviewPartition,
    isActive,
    isPaintable,
    inputLockedRef,
    webviewRef,
    handleInternalFileDragOverRef,
    handleInternalFileDropRef,
    dismissAddressBarSuggestionsRef,
    browserTabUrlRef,
    lastKnownWebviewUrlRef,
    syncNavigationState
  } = args

  const viewport = ensureBrowserPageViewport(browserTabId, workspaceId)
  let container = viewport?.container ?? null
  let webviewContainer = viewport?.content ?? null
  if (!container || !webviewContainer) {
    return
  }

  const ensuredWebview = ensureBrowserPageWebview({
    browserTabId,
    container: webviewContainer,
    inputLocked: inputLockedRef.current,
    webviewPartition,
    resolveContainer: () => ensureBrowserPageViewport(browserTabId, workspaceId)?.content ?? null
  })
  if (!ensuredWebview) {
    return
  }
  container = ensureBrowserPageViewport(browserTabId, workspaceId)?.container ?? null
  webviewContainer = ensuredWebview.container
  if (!container || !webviewContainer) {
    return
  }
  const webview = ensuredWebview.webview
  const needsInitialNavigation = ensuredWebview.created
  seedLiveBrowserUrl(browserTabId, redactKagiSessionToken(browserTabUrlRef.current))

  if (!ensuredWebview.created) {
    // pointerEvents already applied inside ensureBrowserPageWebview for the reused-webview path.
    syncNavigationState(webview)
    // Why: seed from the store URL (getURL() can throw during attach) so URL sync won't force-navigate an already-correct webview.
    lastKnownWebviewUrlRef.current = normalizeBrowserNavigationUrl(browserTabUrlRef.current) ?? null
  }

  webviewRef.current = webview

  // Why: un-park the shell before webview.src is assigned or the guest navigates while hidden and stays blank (the visibility layout effect doesn't re-run on first appear).
  applyBrowserPageViewportLayout(browserTabId, { paintable: isPaintable, active: isActive })

  const onContainerDragOver = (event: globalThis.DragEvent): void => {
    handleInternalFileDragOverRef.current(event as unknown as DragEvent<HTMLDivElement>)
  }
  const onContainerDrop = (event: globalThis.DragEvent): void => {
    handleInternalFileDropRef.current(event as unknown as DragEvent<HTMLDivElement>)
  }
  container.addEventListener('dragover', onContainerDragOver)
  container.addEventListener('drop', onContainerDrop)

  const dismissAddressBarSuggestions = (): void => {
    dismissAddressBarSuggestionsRef.current?.()
  }

  return bindBrowserPageWebviewListeners({
    container,
    webview,
    needsInitialNavigation,
    onContainerDragOver,
    onContainerDrop,
    dismissAddressBarSuggestions,
    args
  })
}
