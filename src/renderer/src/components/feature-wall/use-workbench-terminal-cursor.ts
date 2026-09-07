import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { WorkbenchCursorTarget } from './workbench-terminal-storyboard-state'

export type WorkbenchCursorPosition = { x: number; y: number; visible: boolean }

export function useWorkbenchTerminalCursor(
  panelRef: RefObject<HTMLDivElement | null>,
  leftPaneRef: RefObject<HTMLDivElement | null>,
  splitRowRef: RefObject<HTMLDivElement | null>,
  target: WorkbenchCursorTarget
): WorkbenchCursorPosition {
  const [position, setPosition] = useState<WorkbenchCursorPosition>({
    x: 0,
    y: 0,
    visible: false
  })

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) {
      return
    }
    if (target.kind === 'hidden') {
      setPosition((current) => ({ ...current, visible: false }))
      return
    }
    const panelRect = panel.getBoundingClientRect()
    if (target.kind === 'pane') {
      const pane = leftPaneRef.current
      if (!pane) {
        return
      }
      const rect = pane.getBoundingClientRect()
      setPosition({
        x: rect.left - panelRect.left + 90,
        y: rect.top - panelRect.top + 110,
        visible: true
      })
      return
    }
    const row = splitRowRef.current
    if (!row) {
      return
    }
    const rect = row.getBoundingClientRect()
    setPosition({
      x: rect.left - panelRect.left + 12,
      y: rect.top - panelRect.top + 11,
      visible: true
    })
  }, [target, panelRef, leftPaneRef, splitRowRef])

  return position
}
