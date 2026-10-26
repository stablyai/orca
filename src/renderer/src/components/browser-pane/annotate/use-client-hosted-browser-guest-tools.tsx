import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import { useAppStore } from '@/store'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import type { BrowserChromeMarkupTool } from '../assemble-chrome/browser-chrome-toolbar'
import { BrowserGuestAnnotateOverlays } from './browser-guest-annotate-overlays'
import type { useBrowserPageKeyboardShortcuts } from '../host-guest/use-browser-page-keyboard-shortcuts'
import { useBrowserGuestElementTools } from './use-browser-guest-element-tools'

const NO_MARKER_IDS: readonly string[] = []

/** Main registers the client-hosted guest under its page id, so the tools run as on a local tab. */
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
  overlay: React.JSX.Element
  shortcutBindings: Pick<
    Parameters<typeof useBrowserPageKeyboardShortcuts>[0],
    'markupIsActive' | 'startGrabIntent' | 'handleGrabActionShortcut' | 'grabIsInteractive'
  >
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
    // A pending capture or unsaved card belongs to the document it was picked on.
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
    // An armed grab keeps a window-level C/S listener that must not outlive a usable pane.
    if (disabled && grabActive) {
      cancelGrab()
    }
  }, [cancelGrab, disabled, grabActive])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // The guest's body-level host paints over the pane, so hide it only after capture.
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
    // As on a local tab: saved notes stay, their badges retire, and a half-made pick is dropped.
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
    overlay: (
      <BrowserGuestAnnotateOverlays
        markup={markup}
        grab={grab}
        annotationSend={tools.annotationSend}
        grabAnnotations={grabAnnotations}
        containerRef={viewportRef}
        webviewRef={webviewRef}
        browserOverlayViewport={tools.browserOverlayViewport}
        worktreeId={worktreeId}
      />
    ),
    shortcutBindings: {
      markupIsActive: markup.isActive,
      startGrabIntent: grabAnnotations.startGrabIntent,
      handleGrabActionShortcut: grabAnnotations.handleGrabActionShortcut,
      grabIsInteractive: grabActive && grab.state !== 'error'
    },
    bindAnnotationDocument
  }
}

/** In-place (SPA) main-frame navigations end an annotation document too: they move elements. */
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
