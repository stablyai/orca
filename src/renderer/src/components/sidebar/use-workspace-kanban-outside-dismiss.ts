import { useEffect } from 'react'
import type React from 'react'

const WORKSPACE_BOARD_KEEP_OPEN_SELECTOR = [
  '[data-workspace-board-trigger]',
  '[data-workspace-board-preserve-open]',
  '[data-workspace-status-appearance-popover]',
  '[data-contextual-tour-overlay]',
  '[data-contextual-tour-panel]',
  '[data-radix-popper-content-wrapper]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
  '[data-sonner-toast]',
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[role="menu"][data-state="open"]'
].join(', ')

function eventTargetElement(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null
}

export function isWorkspaceBoardKeepOpenTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target)
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

    const handleOutsideInteraction = (event: MouseEvent): void => {
      const content = boardRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
      if (!content) {
        return
      }
      if (event.target instanceof Node && content.contains(event.target)) {
        return
      }
      // Why: titlebar tabs switch content the board covers, so it must close to show it.
      if (eventTargetElement(event.target)?.closest('[data-workspace-board-dismiss]')) {
        onOpenChange(false)
        return
      }
      if (
        preserveOpenForMenu ||
        event.type === 'click' ||
        isWorkspaceBoardKeepOpenTarget(event.target)
      ) {
        return
      }
      const rect = content.getBoundingClientRect()
      if (event.clientX > rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        onOpenChange(false)
      }
    }

    document.addEventListener('pointerdown', handleOutsideInteraction, true)
    document.addEventListener('click', handleOutsideInteraction, true)
    return () => {
      document.removeEventListener('pointerdown', handleOutsideInteraction, true)
      document.removeEventListener('click', handleOutsideInteraction, true)
    }
  }, [boardRef, onOpenChange, open, preserveOpenForMenu])
}
