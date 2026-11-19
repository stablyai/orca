import { useBrowserAnnotateToolSwitch } from '../annotate/palette/use-browser-annotate-tool-switch'
import { useBrowserAnnotateKeys } from '../host-guest/input/use-browser-annotate-keys'
import type { MutableRefObject } from 'react'
import { useBrowserPageMarkupCapture } from '@/components/browser-pane/annotate/capture/use-browser-page-markup-capture'
import { useBrowserGuestAnnotateTools } from '@/components/browser-pane/annotate/use-browser-guest-annotate-tools'

/** Use the stable browser page ID for annotations and tools so replacing the guest grant preserves both. */
export function useDocPreviewGuestTools({
  previewId,
  worktreeId,
  grantId,
  webviewRef,
  containerRef,
  toolsReady,
  isActive,
  documentGeneration
}: {
  previewId: string
  worktreeId: string
  grantId: string | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  containerRef: MutableRefObject<HTMLDivElement | null>
  toolsReady: boolean
  isActive: boolean
  documentGeneration: number
}) {
  const markup = useBrowserPageMarkupCapture(webviewRef)
  const tools = useBrowserGuestAnnotateTools({
    browserPageId: previewId,
    // No tool target exists before the first grant commits; do not queue requests for a page without a document.
    toolTargetId: grantId === null ? '' : previewId,
    worktreeId,
    isActive: toolsReady,
    // Nothing has painted on a loading or failed preview, so there is no element to pick.
    toolsDisabled: !toolsReady,
    markupIsActive: markup.isActive,
    containerRef,
    guestSurfaceRef: webviewRef
  })
  const toolTargetId = grantId === null ? '' : previewId
  const toolSwitch = useBrowserAnnotateToolSwitch({
    grab: tools.grab,
    grabIntent: tools.grabAnnotations.grabIntent,
    startGrabIntent: tools.grabAnnotations.startGrabIntent,
    cancelPendingBrowserCapture: tools.grabAnnotations.cancelPendingBrowserCapture,
    markup,
    canPickElements: toolsReady,
    toolTargetId,
    documentKey: `${grantId ?? ''}\n${documentGeneration}`
  })
  useBrowserAnnotateKeys({
    browserTabId: toolTargetId,
    isActive: isActive && toolsReady,
    grabIsInteractive: tools.grab.state !== 'idle' && tools.grab.state !== 'error',
    markupIsActive: markup.isActive,
    annotateToolOn: toolSwitch.activeTool !== null,
    handleAnnotateToolKey: toolSwitch.selectToolByKey,
    handleGrabActionShortcut: tools.grabAnnotations.handleGrabActionShortcut
  })
  return {
    ...tools,
    toolSwitch,
    elementTools: { ...tools.elementTools, onStartIntent: toolSwitch.toggleTool },
    markup,
    handleAnnotationViewportMessage: tools.viewportBridge.handleViewportMessage,
    resetBrowserOverlayViewport: tools.viewportBridge.resetOverlayViewport
  }
}
