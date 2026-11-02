import { useContext, useEffect } from 'react'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { IMAGE_VIEWER_ZOOM_STEP } from './image-viewer-zoom'
import type { PanZoomViewport } from './use-pan-zoom-viewport'
import { listenForViewerZoomRequests } from './viewer-zoom-request'

/** Routes app zoom commands (Cmd/Ctrl +, -, 0) to this viewer while its pane owns them. */
export function useViewerZoomCommands(panZoom: PanZoomViewport, priority: 'pane' | 'popup'): void {
  const isCommandOwner = useContext(EditorCommandOwnerContext)
  const { canvas, zoomBy, fit } = panZoom
  useEffect(() => {
    if ((priority === 'pane' && !isCommandOwner) || !canvas) {
      return
    }
    return listenForViewerZoomRequests(
      (direction) => {
        if (direction === 'reset') {
          fit()
        } else {
          zoomBy(direction === 'in' ? IMAGE_VIEWER_ZOOM_STEP : 1 / IMAGE_VIEWER_ZOOM_STEP)
        }
      },
      { current: canvas },
      priority
    )
  }, [canvas, fit, isCommandOwner, priority, zoomBy])
}
