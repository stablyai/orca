import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { syncGuestAnnotationViewportBridge } from '@/components/browser-pane/annotate/guest-annotation-viewport-bridge'
import { consumeBrowserAnnotationViewportMessage } from '@/components/browser-pane/annotate/browser-annotation-viewport-message'
import { useBrowserPageAnnotationSend } from '@/components/browser-pane/annotate/use-browser-page-annotation-send'
import { useBrowserPageGrabAnnotations } from '@/components/browser-pane/annotate/use-browser-page-grab-annotations'
import { useBrowserPageMarkupCapture } from '@/components/browser-pane/annotate/use-browser-page-markup-capture'
import { useGrabMode } from '@/components/browser-pane/annotate/useGrabMode'
import type { BrowserOverlayViewport } from '@/components/browser-pane/describe-page/browser-annotation-geometry'
import type { BrowserChromeElementTools } from '@/components/browser-pane/assemble-chrome/browser-chrome-toolbar'

/** Use the stable browser page ID for annotations and tools so replacing the guest grant preserves both. */
export function useDocPreviewGuestTools({
  previewId,
  worktreeId,
  grantId,
  webviewRef,
  containerRef,
  toolsReady
}: {
  previewId: string
  worktreeId: string
  grantId: string | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  containerRef: MutableRefObject<HTMLDivElement | null>
  toolsReady: boolean
}): {
  grab: ReturnType<typeof useGrabMode>
  markup: ReturnType<typeof useBrowserPageMarkupCapture>
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  browserOverlayViewport: BrowserOverlayViewport
  handleAnnotationViewportMessage: (event: { message?: string }) => void
  resetBrowserOverlayViewport: () => void
  elementTools: BrowserChromeElementTools
} {
  // No tool target exists before the first grant commits; do not queue requests for a page without a document.
  const toolTargetId = grantId === null ? '' : previewId
  const annotationViewportBridgeTokenRef = useRef<string>(undefined!)
  annotationViewportBridgeTokenRef.current ??= createBrowserUuid().replaceAll('-', '')
  const [browserOverlayViewport, setBrowserOverlayViewport] = useState<BrowserOverlayViewport>({
    scrollX: 0,
    scrollY: 0,
    version: 0
  })
  const handleAnnotationViewportMessage = useCallback(
    (event: { message?: string }): void =>
      consumeBrowserAnnotationViewportMessage(
        event,
        annotationViewportBridgeTokenRef.current,
        setBrowserOverlayViewport
      ),
    []
  )
  const resetBrowserOverlayViewport = useCallback(
    (): void => setBrowserOverlayViewport({ scrollX: 0, scrollY: 0, version: 0 }),
    []
  )

  const grabElementShortcut = useShortcutLabel('browser.grabElement')
  const grab = useGrabMode(toolTargetId)
  const markup = useBrowserPageMarkupCapture(webviewRef)
  const annotationSend = useBrowserPageAnnotationSend({ browserTabId: previewId, worktreeId })
  const grabAnnotations = useBrowserPageGrabAnnotations({
    browserTabId: previewId,
    toolTargetId,
    isActive: toolsReady,
    grab,
    containerRef,
    webviewRef,
    setBrowserOverlayViewport,
    browserAnnotationsLength: annotationSend.browserAnnotations.length
  })

  const { browserAnnotations } = annotationSend
  const { pendingAnnotationPayload } = grabAnnotations
  useEffect(() => {
    if (!toolTargetId) {
      return
    }
    syncGuestAnnotationViewportBridge({
      toolTargetId,
      annotations: browserAnnotations,
      pendingPayload: pendingAnnotationPayload,
      surfaceActive: toolsReady,
      token: annotationViewportBridgeTokenRef.current
    })
  }, [browserAnnotations, pendingAnnotationPayload, toolTargetId, toolsReady])

  const elementTools = useMemo<BrowserChromeElementTools>(
    () => ({
      activeIntent: grab.state !== 'idle' ? grabAnnotations.grabIntent : null,
      onStartIntent: grabAnnotations.startGrabIntent,
      // Nothing has painted on a loading or failed preview, so there is no element to pick.
      disabled: !toolsReady || markup.isActive,
      grabShortcutLabel: grabElementShortcut,
      annotationCount: browserAnnotations.length
    }),
    [
      browserAnnotations.length,
      grab.state,
      grabAnnotations.grabIntent,
      grabAnnotations.startGrabIntent,
      grabElementShortcut,
      markup.isActive,
      toolsReady
    ]
  )

  return {
    grab,
    markup,
    annotationSend,
    grabAnnotations,
    browserOverlayViewport,
    handleAnnotationViewportMessage,
    resetBrowserOverlayViewport,
    elementTools
  }
}
