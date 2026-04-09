import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'

type FontZoomDeps = {
  isActive: boolean
  managerRef: React.RefObject<PaneManager | null>
  paneFontSizesRef: React.RefObject<Map<number, number>>
  settingsRef: React.RefObject<{ terminalFontSize?: number } | null>
}

export function useTerminalFontZoom({
  isActive,
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
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }

      const percent = Math.round((nextSize / globalSize) * 100)
      dispatchZoomLevelChanged('terminal', percent)
    })
  }, [isActive, managerRef, paneFontSizesRef, settingsRef])
}
