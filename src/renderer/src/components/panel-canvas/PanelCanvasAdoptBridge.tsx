import React from 'react'
import { useAppStore } from '@/store'
import { normalizePanelLayouts } from '../../../../shared/panel-layouts'
import { canvasNodeFromLayout } from '@/lib/panel-canvas'

/** Always-mounted listener in the main window: when a detached popout
 *  reattaches, adopt its canvas tree and show the canvas view. Lives outside
 *  PanelCanvasPage because that page only mounts while a canvas is open. */
export function PanelCanvasAdoptBridge(): null {
  React.useEffect(
    () =>
      window.api.panelCanvasPopout.onAdopt((payload) => {
        // Why: the tree crossed a window boundary — same normalizer as
        // persisted layouts before trusting the shape.
        const normalized = normalizePanelLayouts([
          { id: 'adopt', title: payload.title ?? 'canvas', root: payload.layout }
        ])
        if (normalized.length === 0) {
          return
        }
        useAppStore
          .getState()
          .adoptDetachedPanelCanvas(canvasNodeFromLayout(normalized[0].root), payload.layoutId)
      }),
    []
  )
  return null
}
