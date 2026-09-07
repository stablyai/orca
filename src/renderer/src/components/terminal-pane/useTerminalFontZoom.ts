import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { overridePendingPaneMetricOptions } from '@/lib/pane-manager/pane-metric-options-deferral'
import { getPaneOwnedActiveHelperTextarea } from './regular-terminal-focus-ownership'

type FontZoomDeps = {
  isActive: boolean
  containerRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  paneFontSizesRef: React.RefObject<Map<number, number>>
  settingsRef: React.RefObject<{ terminalFontSize?: number } | null>
}

export function useTerminalFontZoom({
  isActive,
  containerRef,
  managerRef,
  paneFontSizesRef,
  settingsRef
}: FontZoomDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }
    const MIN_FONT_SIZE = 8
    const MAX_FONT_SIZE = 32
    const FONT_SIZE_STEP = 1

    return window.api.ui.onTerminalZoom((direction) => {
      const container = containerRef.current
      if (!container || !getPaneOwnedActiveHelperTextarea(container, document.activeElement)) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane()
      if (!pane) {
        return
      }

      const globalSize = settingsRef.current?.terminalFontSize ?? 14
      const currentSize = paneFontSizesRef.current.get(pane.id) ?? globalSize

      let nextSize: number
      if (direction === 'reset') {
        nextSize = globalSize
        paneFontSizesRef.current.delete(pane.id)
      } else if (direction === 'in') {
        nextSize = Math.min(MAX_FONT_SIZE, currentSize + FONT_SIZE_STEP)
        paneFontSizesRef.current.set(pane.id, nextSize)
      } else {
        nextSize = Math.max(MIN_FONT_SIZE, currentSize - FONT_SIZE_STEP)
        paneFontSizesRef.current.set(pane.id, nextSize)
      }

      pane.terminal.options.fontSize = nextSize
      // Why: safeFit flushes parked metric options, which would otherwise
      // overwrite this zoom with the font size captured while the pane was
      // unmeasurable. Fold the new size in; other parked keys still apply.
      overridePendingPaneMetricOptions(pane, { fontSize: nextSize })
      safeFit(pane)

      const percent = Math.round((nextSize / globalSize) * 100)
      dispatchZoomLevelChanged('terminal', percent)
    })
  }, [containerRef, isActive, managerRef, paneFontSizesRef, settingsRef])
}
