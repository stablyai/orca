import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { dispatchZoomLevelChanged } from '@/lib/zoom-events'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { getPaneOwnedActiveHelperTextarea } from './regular-terminal-focus-ownership'

const DEFAULT_FONT_SIZE = 14
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32

type FontZoomDeps = {
  isActive: boolean
  containerRef: React.RefObject<HTMLElement | null>
  managerRef: React.RefObject<PaneManager | null>
  settingsRef: React.RefObject<{ terminalFontSize?: number } | null>
  updateSettings: (updates: { terminalFontSize: number }) => void | Promise<void>
}

export function useTerminalFontZoom({
  isActive,
  containerRef,
  managerRef,
  settingsRef,
  updateSettings
}: FontZoomDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onTerminalZoom((direction) => {
      const container = containerRef.current
      if (!container || !getPaneOwnedActiveHelperTextarea(container, document.activeElement)) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length === 0) {
        return
      }

      const currentSize = settingsRef.current?.terminalFontSize ?? DEFAULT_FONT_SIZE

      let nextSize: number
      if (direction === 'reset') {
        nextSize = DEFAULT_FONT_SIZE
      } else if (direction === 'in') {
        nextSize = Math.min(MAX_FONT_SIZE, currentSize + 1)
      } else {
        nextSize = Math.max(MIN_FONT_SIZE, currentSize - 1)
      }

      if (settingsRef.current) {
        settingsRef.current = { ...settingsRef.current, terminalFontSize: nextSize }
      }
      for (const pane of panes) {
        pane.terminal.options.fontSize = nextSize
        safeFit(pane)
      }
      void updateSettings({ terminalFontSize: nextSize })

      const percent = Math.round((nextSize / DEFAULT_FONT_SIZE) * 100)
      dispatchZoomLevelChanged('terminal', percent)
    })
  }, [containerRef, isActive, managerRef, settingsRef, updateSettings])
}
