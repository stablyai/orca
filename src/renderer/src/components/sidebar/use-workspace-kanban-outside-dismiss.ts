import { useEffect } from 'react'
import type React from 'react'

const WORKSPACE_BOARD_KEEP_OPEN_SELECTOR =
  '[data-workspace-board-trigger], [data-workspace-board-preserve-open]'

export function isWorkspaceBoardKeepOpenTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(WORKSPACE_BOARD_KEEP_OPEN_SELECTOR))
}

export function useWorkspaceKanbanOutsideDismiss(params: {
  open: boolean
  boardRef: React.RefObject<HTMLDivElement | null>
  preserveOpenForMenu: boolean
  onOpenChange: (open: boolean) => void
}): void {
  const { open, boardRef, preserveOpenForMenu, onOpenChange } = params

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const content = boardRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
      if (!content || preserveOpenForMenu) {
        return
      }
      if (event.target instanceof Node && content.contains(event.target)) {
        return
      }
      if (isWorkspaceBoardKeepOpenTarget(event.target)) {
        return
      }
      const rect = content.getBoundingClientRect()
      if (event.clientX > rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [boardRef, onOpenChange, open, preserveOpenForMenu])
}
