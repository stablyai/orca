import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import '@/lib/pane-manager/pane-tree-ops'
import { safeFit } from '@/lib/pane-manager/pane-fit'
import { overridePendingPaneMetricOptions } from '@/lib/pane-manager/pane-metric-options-deferral'
import { getPaneOwnedActiveHelperTextarea } from '../input/focus/regular-terminal-focus-ownership'
import {
  clearTerminalFontSizeOverride,
  getTerminalFontSizeOverride,
  setTerminalFontSizeOverride
} from './terminal-font-size-overrides'

type FontZoomDeps = {
  isActive: boolean
  containerRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  settingsRef: React.RefObject<{ terminalFontSize?: number } | null>
}

export function useTerminalFontZoom({
  isActive,
  containerRef,
  managerRef,
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
      const currentSize = getTerminalFontSizeOverride(pane.leafId) ?? globalSize

      let nextSize: number
      if (direction === 'reset') {
        nextSize = globalSize
        clearTerminalFontSizeOverride(pane.leafId)
      } else {
        nextSize =
          direction === 'in'
            ? Math.min(MAX_FONT_SIZE, currentSize + FONT_SIZE_STEP)
            : Math.max(MIN_FONT_SIZE, currentSize - FONT_SIZE_STEP)
        setTerminalFontSizeOverride(pane.leafId, nextSize)
      }

      pane.terminal.options.fontSize = nextSize
      // Fold zoom into parked metrics before safeFit flushes them, or the captured font size overwrites it.
      overridePendingPaneMetricOptions(pane, { fontSize: nextSize })
      safeFit(pane)

      const percent = Math.round((nextSize / globalSize) * 100)
      dispatchZoomLevelChanged('terminal', percent)
    })
  }, [containerRef, isActive, managerRef, settingsRef])
}
