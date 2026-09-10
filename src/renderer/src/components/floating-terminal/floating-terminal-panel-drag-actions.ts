import type { MouseEvent, PointerEvent } from 'react'
import { isFloatingTerminalDragTarget } from './floating-terminal-panel-drag-target'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelFocusReclaim } from './use-floating-terminal-panel-focus-reclaim'
import type { FloatingTerminalPanelMaximize } from './use-floating-terminal-panel-maximize'
import type { useFloatingTerminalPanelGeometry } from './use-floating-terminal-panel-geometry'

type FloatingTerminalPanelDragActionsInput = Pick<
  FloatingTerminalPanelLocalState,
  'maximized' | 'dragRef' | 'bounds'
> &
  Pick<FloatingTerminalPanelFocusReclaim, 'focusPanelForShortcuts'> &
  Pick<
    ReturnType<typeof useFloatingTerminalPanelGeometry>,
    'previewUserBounds' | 'commitUserBounds'
  > &
  FloatingTerminalPanelMaximize

export function createFloatingTerminalPanelDragActions({
  maximized,
  dragRef,
  bounds,
  focusPanelForShortcuts,
  previewUserBounds,
  commitUserBounds,
  toggleMaximized
}: FloatingTerminalPanelDragActionsInput) {
  const handleDragStart = (event: PointerEvent<HTMLDivElement>): void => {
    if (maximized || event.button !== 0 || !isFloatingTerminalDragTarget(event.target)) {
      return
    }
    focusPanelForShortcuts()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      bounds,
      moved: false
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleDragMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (dx === 0 && dy === 0) {
      return
    }
    drag.moved = true
    previewUserBounds({
      ...drag.bounds,
      left: drag.bounds.left + dx,
      top: drag.bounds.top + dy
    })
  }
  const handleDragEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    if (drag.moved) {
      commitUserBounds()
    }
    dragRef.current = null
  }
  const handleTitlebarDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !isFloatingTerminalDragTarget(event.target)) {
      return
    }
    event.preventDefault()
    toggleMaximized()
  }
  return { handleDragStart, handleDragMove, handleDragEnd, handleTitlebarDoubleClick }
}
