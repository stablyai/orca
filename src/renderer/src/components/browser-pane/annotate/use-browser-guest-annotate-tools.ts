import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useAppStore } from '@/store'
import { syncGuestAnnotationViewportBridge } from './viewport/guest-annotation-viewport-bridge'
import { consumeBrowserAnnotationViewportMessage } from './viewport/browser-annotation-viewport-message'
import { useBrowserPageAnnotationSend } from './delivery/use-browser-page-annotation-send'
import { useBrowserPageGrabAnnotations } from './grab/use-browser-page-grab-annotations'
import { useGrabMode } from './grab/useGrabMode'
import { useBrowserGrabShortcuts } from './use-browser-grab-shortcuts'
import {
  ipcBrowserGuestToolsTransport,
  type BrowserGuestToolsTransport
} from './browser-guest-tools-transport'
import {
  EMPTY_BROWSER_ANNOTATIONS,
  INITIAL_BROWSER_OVERLAY_VIEWPORT,
  type BrowserOverlayViewport,
  type OverlayRectSource
} from '../describe-page/browser-annotation-geometry'
import type { BrowserGuestDocumentEvent } from '../../../../../shared/browser/annotations/browser-guest-document-event'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import type {
  BrowserChromeElementTools,
  BrowserChromeNoteActions
} from '../assemble-chrome/toolbar/browser-annotate-tool-button'

function createViewportBridgeToken(): string {
  return createBrowserUuid().replaceAll('-', '')
}

export type BrowserGuestAnnotationViewportBridge = {
  tokenRef: MutableRefObject<string>
  sync: () => void
  /** The guest replaced its document: stored boxes and the pending pick no longer describe it. */
  invalidateDocument: () => void
  handleViewportMessage: (event: { message?: string }) => void
  resetOverlayViewport: () => void
  /** One entry point for the guest's document events, from a webview or relayed by the page's host. */
  handleGuestDocumentEvent: (event: BrowserGuestDocumentEvent) => void
}

/** One element picker and note set for every surface that shows a page: local, client-hosted, streamed, or a doc preview. */
export function useBrowserGuestAnnotateTools({
  browserPageId,
  toolTargetId = browserPageId,
  worktreeId,
  isActive,
  toolsDisabled = false,
  markupIsActive,
  containerRef,
  guestSurfaceRef,
  trackingContainer,
  trackingScroller,
  currentDocumentUrl,
  transport = ipcBrowserGuestToolsTransport,
  shortcuts
}: {
  /** Scopes stored notes. Stable for the life of the surface. */
  browserPageId: string
  /** Empty while no guest exists, so no request queues for a page without a document. */
  toolTargetId?: string
  worktreeId: string
  isActive: boolean
  toolsDisabled?: boolean
  markupIsActive: boolean
  containerRef: MutableRefObject<HTMLDivElement | null>
  guestSurfaceRef: RefObject<OverlayRectSource | null>
  trackingContainer?: HTMLDivElement | null
  trackingScroller?: HTMLDivElement | null
  /** Browsing pages show only the badges captured on the committed document; previews show every note. */
  currentDocumentUrl?: string
  transport?: BrowserGuestToolsTransport
  /** Wires the grab/annotate chords and C/S picks; doc previews leave the chords to the editor. */
  shortcuts?: {
    workspaceId: string
    chromeShortcutScope: BrowserChromeShortcutScope
    bind?: boolean
  }
}): {
  grab: ReturnType<typeof useGrabMode>
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  browserOverlayViewport: BrowserOverlayViewport
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  viewportBridge: BrowserGuestAnnotationViewportBridge
  elementTools: BrowserChromeElementTools
  notes: BrowserChromeNoteActions
} {
  const [browserOverlayViewport, setBrowserOverlayViewport] = useState<BrowserOverlayViewport>(
    INITIAL_BROWSER_OVERLAY_VIEWPORT
  )
  const grabElementShortcut = useShortcutLabel('browser.grabElement')
  const annotateElementShortcut = useShortcutLabel('browser.annotateElement')
  const grab = useGrabMode(toolTargetId, transport)
  const annotationSend = useBrowserPageAnnotationSend({ browserTabId: browserPageId, worktreeId })
  const grabAnnotations = useBrowserPageGrabAnnotations({
    browserTabId: browserPageId,
    toolTargetId,
    isActive,
    grab,
    containerRef,
    trackingContainer,
    trackingScroller,
    guestSurfaceRef,
    setBrowserOverlayViewport,
    browserAnnotationsLength: annotationSend.browserAnnotations.length
  })
  const { browserAnnotations } = annotationSend
  const { pendingAnnotationPayload, cancelPendingBrowserCapture } = grabAnnotations
  const markerIds = useAppStore((s) =>
    currentDocumentUrl === undefined
      ? undefined
      : s.browserAnnotationMarkerIdsByPageId[browserPageId]
  )

  const [token] = useState(createViewportBridgeToken)
  const tokenRef = useRef(token)
  const isActiveRef = useRef(isActive)
  const pendingAnnotationPayloadRef = useRef(pendingAnnotationPayload)
  const currentDocumentUrlRef = useRef(currentDocumentUrl)
  const cancelPendingBrowserCaptureRef = useRef(cancelPendingBrowserCapture)
  useLayoutEffect(() => {
    isActiveRef.current = isActive
    pendingAnnotationPayloadRef.current = pendingAnnotationPayload
    currentDocumentUrlRef.current = currentDocumentUrl
    cancelPendingBrowserCaptureRef.current = cancelPendingBrowserCapture
  }, [cancelPendingBrowserCapture, currentDocumentUrl, isActive, pendingAnnotationPayload])

  // Stable identity: the local pane reattaches its guest when this changes.
  const sync = useCallback((): void => {
    if (!toolTargetId) {
      return
    }
    const state = useAppStore.getState()
    const documentUrl = currentDocumentUrlRef.current
    syncGuestAnnotationViewportBridge({
      toolTargetId,
      annotations: state.browserAnnotationsByPageId[browserPageId] ?? EMPTY_BROWSER_ANNOTATIONS,
      ...(documentUrl === undefined
        ? {}
        : {
            currentDocument: {
              markerIds: state.browserAnnotationMarkerIdsByPageId[browserPageId] ?? [],
              url: documentUrl
            }
          }),
      pendingPayload: pendingAnnotationPayloadRef.current,
      surfaceActive: isActiveRef.current,
      token: tokenRef.current,
      transport
    })
  }, [browserPageId, toolTargetId, transport])

  const invalidateDocument = useCallback((): void => {
    useAppStore.getState().invalidateBrowserPageAnnotationGeometry(browserPageId)
    cancelPendingBrowserCaptureRef.current()
    pendingAnnotationPayloadRef.current = null
    sync()
  }, [browserPageId, sync])

  const handleViewportMessage = useCallback(
    (event: { message?: string }): void =>
      consumeBrowserAnnotationViewportMessage(event, tokenRef.current, setBrowserOverlayViewport),
    []
  )
  const resetOverlayViewport = useCallback(
    (): void => setBrowserOverlayViewport(INITIAL_BROWSER_OVERLAY_VIEWPORT),
    []
  )

  // Previews have no document URL; browsing pages start from their current route.
  const committedDocumentPathRef = useRef<string | null>(currentDocumentUrl?.split('#')[0] ?? null)
  const handleGuestDocumentEvent = useCallback(
    (event: BrowserGuestDocumentEvent): void => {
      switch (event.type) {
        case 'viewport':
          handleViewportMessage(event)
          return
        case 'documentStart':
          // A reload keeps its URL but not its elements, so this, not a URL change, retires the draft.
          committedDocumentPathRef.current = null
          invalidateDocument()
          resetOverlayViewport()
          return
        case 'navigated': {
          // In-place route changes swap content, but fragment-only updates (scroll spies, anchors) keep the layout.
          const path = event.url.split('#')[0]
          const previous = committedDocumentPathRef.current
          committedDocumentPathRef.current = path
          if (previous !== null && previous !== path) {
            invalidateDocument()
          }
          return
        }
        case 'domReady':
          // The badge script lives in the document, so every new document needs it again.
          sync()
      }
    },
    [handleViewportMessage, invalidateDocument, resetOverlayViewport, sync]
  )

  useEffect(() => {
    sync()
  }, [browserAnnotations, markerIds, currentDocumentUrl, isActive, pendingAnnotationPayload, sync])

  const hasShortcuts = shortcuts !== undefined
  useBrowserGrabShortcuts({
    enabled: hasShortcuts && shortcuts.bind !== false && toolTargetId !== '',
    transport,
    browserTabId: toolTargetId,
    workspaceId: shortcuts?.workspaceId ?? '',
    chromeShortcutScope: shortcuts?.chromeShortcutScope ?? 'inactive',
    markupIsActive,
    toolsDisabled,
    startGrabIntent: grabAnnotations.startGrabIntent,
    handleGrabActionShortcut: grabAnnotations.handleGrabActionShortcut,
    grabIsInteractive: grab.state !== 'idle' && grab.state !== 'error'
  })

  const viewportBridge = useMemo<BrowserGuestAnnotationViewportBridge>(
    () => ({
      tokenRef,
      sync,
      invalidateDocument,
      handleViewportMessage,
      resetOverlayViewport,
      handleGuestDocumentEvent
    }),
    [
      handleGuestDocumentEvent,
      handleViewportMessage,
      invalidateDocument,
      resetOverlayViewport,
      sync
    ]
  )

  const elementTools = useMemo<BrowserChromeElementTools>(
    () => ({
      activeIntent: grab.state !== 'idle' ? grabAnnotations.grabIntent : null,
      onStartIntent: grabAnnotations.startGrabIntent,
      disabled: !toolTargetId || toolsDisabled || markupIsActive,
      grabShortcutLabel: grabElementShortcut,
      ...(hasShortcuts ? { annotateShortcutLabel: annotateElementShortcut } : {}),
      annotationCount: browserAnnotations.length
    }),
    [
      annotateElementShortcut,
      browserAnnotations.length,
      grab.state,
      grabAnnotations.grabIntent,
      grabAnnotations.startGrabIntent,
      grabElementShortcut,
      hasShortcuts,
      markupIsActive,
      toolTargetId,
      toolsDisabled
    ]
  )

  const notes = useMemo<BrowserChromeNoteActions>(
    () => ({
      onCopyAll: annotationSend.handleCopyBrowserAnnotations,
      onClear: annotationSend.handleClearBrowserAnnotations
    }),
    [annotationSend.handleClearBrowserAnnotations, annotationSend.handleCopyBrowserAnnotations]
  )

  return {
    grab,
    annotationSend,
    grabAnnotations,
    browserOverlayViewport,
    setBrowserOverlayViewport,
    viewportBridge,
    elementTools,
    notes
  }
}
