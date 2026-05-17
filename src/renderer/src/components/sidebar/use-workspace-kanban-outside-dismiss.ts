import { useEffect } from 'react'
import type React from 'react'

const WORKSPACE_BOARD_KEEP_OPEN_SELECTOR = [
  '[data-workspace-board-trigger]',
  '[data-workspace-board-preserve-open]',
  '[data-workspace-status-appearance-popover]',
  '[data-radix-popper-content-wrapper]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]'
].join(', ')

export function isWorkspaceBoardKeepOpenTarget(target: EventTarget | null): boolean {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  // Why: board-owned menus and confirmation dialogs portal to document.body,
  // so DOM containment alone would treat their clicks/focus as board exits.
  return Boolean(element?.closest(WORKSPACE_BOARD_KEEP_OPEN_SELECTOR))
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
