import { useCallback, useLayoutEffect } from 'react'
import {
  arePaneTitleOverlayRectsEqual,
  clearPaneTitleOverlayRects
} from '../pane-title-overlay-rects'
import type { PaneTitleOverlayRect } from '../TerminalPaneHeaderOverlay'
import type { TerminalPaneCloseController } from '../layout/close/use-terminal-pane-close-actions'

export function usePaneTitleOverlayGeometry({
  containerRef,
  expandedPaneId,
  isolatedPaneKey,
  isVisible,
  managerRef,
  paneCount,
  paneLayoutRevision,
  paneTitles,
  renamingPaneId,
  sessionRestoredBannerPaneIds,
  setPaneTitleOverlayRects,
  shouldMeasureHiddenStartup
}: Pick<
  TerminalPaneCloseController,
  | 'containerRef'
  | 'expandedPaneId'
  | 'isolatedPaneKey'
  | 'isVisible'
  | 'managerRef'
  | 'paneCount'
  | 'paneLayoutRevision'
  | 'paneTitles'
  | 'renamingPaneId'
  | 'sessionRestoredBannerPaneIds'
  | 'setPaneTitleOverlayRects'
  | 'shouldMeasureHiddenStartup'
>): void {
  const syncPaneTitleOverlayRects = useCallback((): void => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
      return
    }
    const containerRect = container.getBoundingClientRect()
    const nextRects: Record<number, PaneTitleOverlayRect> = {}
    for (const pane of manager.getPanes()) {
      const paneRect = pane.container.getBoundingClientRect()
      if (paneRect.width <= 0 || paneRect.height <= 0) {
        continue
      }
      nextRects[pane.id] = {
        left: paneRect.left - containerRect.left,
        top: paneRect.top - containerRect.top,
        width: paneRect.width
      }
    }
    setPaneTitleOverlayRects((previous) =>
      arePaneTitleOverlayRectsEqual(previous, nextRects) ? previous : nextRects
    )
  }, [containerRef, managerRef, setPaneTitleOverlayRects])

  useLayoutEffect(() => {
    const manager = managerRef.current
    const container = containerRef.current
    if (!manager || !container) {
      setPaneTitleOverlayRects(clearPaneTitleOverlayRects)
      return
    }
    // Hidden overlays are display:none; keeping their last rects avoids a forced layout and a pane re-render on every workspace switch.
    if (!isVisible && !shouldMeasureHiddenStartup) {
      return
    }
    let frame: number | null = null
    const scheduleSync = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      frame = requestAnimationFrame(() => {
        frame = null
        syncPaneTitleOverlayRects()
      })
    }
    syncPaneTitleOverlayRects()
    const resizeObserver = new ResizeObserver(scheduleSync)
    resizeObserver.observe(container)
    for (const pane of manager.getPanes()) {
      resizeObserver.observe(pane.container)
    }
    return () => {
      resizeObserver.disconnect()
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [
    expandedPaneId,
    isolatedPaneKey,
    isVisible,
    paneCount,
    paneLayoutRevision,
    paneTitles,
    renamingPaneId,
    sessionRestoredBannerPaneIds,
    shouldMeasureHiddenStartup,
    syncPaneTitleOverlayRects,
    containerRef,
    managerRef,
    setPaneTitleOverlayRects
  ])
}
