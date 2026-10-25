import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import { useAppStore } from '@/store'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import type { BrowserChromeMarkupTool } from '../assemble-chrome/browser-chrome-toolbar'
import { useBrowserGuestElementTools } from './use-browser-guest-element-tools'

const NO_MARKER_IDS: readonly string[] = []

/**
 * The browser tool cluster for a client-hosted page. Its `<webview>` is local, and main registers
 * it under the page id, so the picker and markup run exactly as on a local tab.
 */
export function useClientHostedBrowserGuestTools({
  browserPageId,
  worktreeId,
  webviewRef,
  viewportRef,
  runtimeEnvironmentId,
  placement,
  isActive,
  unavailable,
  showFailureOverlay,
  documentUrl
}: {
  browserPageId: string
  worktreeId: string
  webviewRef: RefObject<Electron.WebviewTag | null>
  viewportRef: RefObject<HTMLDivElement | null>
  runtimeEnvironmentId: string
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  unavailable: boolean
  showFailureOverlay: boolean
  documentUrl: string
}): ReturnType<typeof useBrowserGuestElementTools> & {
  markupTool: BrowserChromeMarkupTool
  /** Binds the guest's document-boundary and viewport events; returns the unbind. */
  bindAnnotationDocument: (webview: Electron.WebviewTag) => () => void
} {
  const disabled = !isActive || placement === null || unavailable || showFailureOverlay
  const liveMarkerIds = useAppStore(
    (state) => state.browserAnnotationMarkerIdsByPageId[browserPageId] ?? NO_MARKER_IDS
  )
  const currentDocument = useMemo(
    () => ({ markerIds: liveMarkerIds, url: documentUrl }),
    [documentUrl, liveMarkerIds]
  )
  const tools = useBrowserGuestElementTools({
    browserPageId,
    // Why empty until placed: main registers the guest only once the host adopts the page.
    toolTargetId: placement === null ? '' : browserPageId,
    worktreeId,
    webviewRef,
    containerRef: viewportRef,
    toolsReady: !disabled,
    currentDocument
  })
  const { markup, grab, grabAnnotations, resetBrowserOverlayViewport } = tools
  const { handleAnnotationViewportMessage } = tools
  const { setPendingAnnotationPayload, cancelPendingBrowserCapture } = grabAnnotations
  const cancelMarkup = markup.cancel
  const showOverlay = !disabled && markup.isActive && markup.baseImage !== null
  const browserHostClientId = placement?.browserHostClientId
  const browserHostGeneration = placement?.browserHostGeneration
  const pageHostGeneration = placement?.pageHostGeneration

  useEffect(() => {
    // Invalidate pending captures and an unsaved comment card on deactivation, guest replacement,
    // failure, or unmount — the card's element rects belong to the document it was picked on.
    return () => {
      cancelMarkup()
      setPendingAnnotationPayload(null)
    }
  }, [
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    disabled,
    cancelMarkup,
    setPendingAnnotationPayload
  ])

  const grabActive = grab.state !== 'idle'
  const cancelGrab = grab.cancel
  useEffect(() => {
    // Why: an armed or confirming grab keeps its window-level C/S listener, so it must not outlive
    // an unusable pane.
    if (disabled && grabActive) {
      cancelGrab()
    }
  }, [cancelGrab, disabled, grabActive])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: the guest lives in a body-level fixed host that paints over the pane, so hide it only
    // after capture, or it would cover the drawing surface.
    webview.style.display = showFailureOverlay || unavailable || showOverlay ? 'none' : 'flex'
    return () => {
      webview.style.display = 'flex'
    }
  }, [
    webviewRef,
    browserPageId,
    runtimeEnvironmentId,
    browserHostClientId,
    browserHostGeneration,
    pageHostGeneration,
    showFailureOverlay,
    unavailable,
    showOverlay
  ])

  const invalidateAnnotationDocument = useCallback(() => {
    // Why: a load replaces the document, so saved notes are kept (as on a local tab) but their
    // badges retire, and a half-made pick — awaiting or confirming — is dropped with its rects.
    useAppStore.getState().invalidateBrowserPageAnnotationGeometry(browserPageId)
    cancelPendingBrowserCapture()
    resetBrowserOverlayViewport()
  }, [browserPageId, cancelPendingBrowserCapture, resetBrowserOverlayViewport])
  const bindAnnotationDocument = useCallback(
    (webview: Electron.WebviewTag) =>
      bindClientHostedAnnotationDocument(webview, {
        invalidate: invalidateAnnotationDocument,
        onViewportMessage: handleAnnotationViewportMessage
      }),
    [handleAnnotationViewportMessage, invalidateAnnotationDocument]
  )

  return {
    ...tools,
    markupTool: {
      active: markup.isActive,
      disabled: disabled || grabActive,
      onToggle: () => (markup.isActive ? markup.cancel() : void markup.start()),
      canShowDiscoveryHint: isActive
    },
    bindAnnotationDocument
  }
}

/**
 * The guest events that end an annotation document, plus the viewport reports the comment card
 * follows. Main-frame starts include in-place (SPA) navigations, which move elements just the same.
 */
function bindClientHostedAnnotationDocument(
  webview: Electron.WebviewTag,
  {
    invalidate,
    onViewportMessage
  }: { invalidate: () => void; onViewportMessage: (event: { message?: string }) => void }
): () => void {
  const onStartNavigation = (event: Electron.DidStartNavigationEvent): void => {
    if (event.isMainFrame && event.url) {
      invalidate()
    }
  }
  webview.addEventListener('did-start-loading', invalidate)
  webview.addEventListener('did-start-navigation', onStartNavigation)
  webview.addEventListener('console-message', onViewportMessage)
  return () => {
    webview.removeEventListener('did-start-loading', invalidate)
    webview.removeEventListener('did-start-navigation', onStartNavigation)
    webview.removeEventListener('console-message', onViewportMessage)
  }
}
