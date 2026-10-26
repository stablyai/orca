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

/** Element picker, annotations and markup for webviews outside the browsing pane: doc previews and client-hosted pages. */
export function useBrowserGuestElementTools({
  browserPageId,
  toolTargetId,
  worktreeId,
  webviewRef,
  containerRef,
  toolsReady,
  currentDocument
}: {
  browserPageId: string
  /** The id main resolves to a guest, or '' while no guest has committed to this page. */
  toolTargetId: string
  worktreeId: string
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  containerRef: MutableRefObject<HTMLDivElement | null>
  toolsReady: boolean
  /** Set by a surface that navigates, so badges show only notes from the live document. */
  currentDocument?: { markerIds: readonly string[]; url: string }
}): {
  grab: ReturnType<typeof useGrabMode>
  markup: ReturnType<typeof useBrowserPageMarkupCapture>
  annotationSend: ReturnType<typeof useBrowserPageAnnotationSend>
  grabAnnotations: ReturnType<typeof useBrowserPageGrabAnnotations>
  browserOverlayViewport: BrowserOverlayViewport
  /** Feed the guest's `console-message` events here: the card follows the picked element by them. */
  handleAnnotationViewportMessage: (event: { message?: string }) => void
  resetBrowserOverlayViewport: () => void
  elementTools: BrowserChromeElementTools
} {
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
  const annotationSend = useBrowserPageAnnotationSend({ browserTabId: browserPageId, worktreeId })
  const grabAnnotations = useBrowserPageGrabAnnotations({
    browserTabId: browserPageId,
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
      currentDocument,
      pendingPayload: pendingAnnotationPayload,
      surfaceActive: toolsReady,
      token: annotationViewportBridgeTokenRef.current
    })
  }, [browserAnnotations, currentDocument, pendingAnnotationPayload, toolTargetId, toolsReady])

  const elementTools = useMemo<BrowserChromeElementTools>(
    () => ({
      activeIntent: grab.state !== 'idle' ? grabAnnotations.grabIntent : null,
      onStartIntent: grabAnnotations.startGrabIntent,
      // Nothing has painted on a loading or failed guest, so there is no element to pick.
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
