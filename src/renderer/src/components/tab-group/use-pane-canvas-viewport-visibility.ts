import { useCallback, useLayoutEffect, useRef } from 'react'
import { collectVisiblePaneCanvasTerminalIds } from './pane-canvas-extent'
import type { PaneCanvasBounds } from './pane-canvas-layout-state'

const CANVAS_VISIBILITY_MARGIN_PX = 128

export function usePaneCanvasViewportVisibility({
  terminalTabIds,
  boundsByTerminalTabId,
  onVisibleTerminalTabIdsChange
}: {
  terminalTabIds: readonly string[]
  boundsByTerminalTabId: Readonly<Record<string, PaneCanvasBounds>>
  onVisibleTerminalTabIdsChange: (terminalTabIds: ReadonlySet<string>) => void
}): React.RefObject<HTMLDivElement | null> {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const publishViewportVisibility = useCallback(() => {
    const viewport = viewportRef.current
    onVisibleTerminalTabIdsChange(
      viewport
        ? collectVisiblePaneCanvasTerminalIds(
            terminalTabIds,
            boundsByTerminalTabId,
            viewport,
            CANVAS_VISIBILITY_MARGIN_PX
          )
        : new Set(terminalTabIds)
    )
  }, [boundsByTerminalTabId, onVisibleTerminalTabIdsChange, terminalTabIds])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      publishViewportVisibility()
      return
    }
    let frameId: number | null = null
    const schedulePublish = (): void => {
      if (frameId !== null) {
        return
      }
      frameId = requestAnimationFrame(() => {
        frameId = null
        publishViewportVisibility()
      })
    }
    publishViewportVisibility()
    const resizeObserver = new ResizeObserver(schedulePublish)
    resizeObserver.observe(viewport)
    viewport.addEventListener('scroll', schedulePublish, { passive: true })
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
      resizeObserver.disconnect()
      viewport.removeEventListener('scroll', schedulePublish)
    }
  }, [publishViewportVisibility])

  return viewportRef
}
