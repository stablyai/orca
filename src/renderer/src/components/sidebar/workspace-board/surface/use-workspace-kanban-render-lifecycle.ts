import { startTransition, useEffect, useState } from 'react'
import { isWorkspaceBoardKeepOpenTarget } from './use-workspace-kanban-outside-dismiss'

export function useWorkspaceKanbanRenderLifecycle(args: {
  boardRef: React.RefObject<HTMLDivElement | null>
  clearSelection: () => void
  open: boolean
  selectedCount: number
}): boolean {
  const { boardRef, clearSelection, open, selectedCount } = args
  const [renderCards, setRenderCards] = useState(false)
  useEffect(() => {
    if (!open) {
      setRenderCards(false)
      return
    }
    let cancelled = false
    const frameId = window.requestAnimationFrame(() => {
      startTransition(() => {
        if (!cancelled) {
          setRenderCards(true)
        }
      })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [open])
  useEffect(() => {
    if (!open || selectedCount === 0) {
      return
    }
    const clearSelectionOutsideBoard = (event: PointerEvent): void => {
      const content = boardRef.current?.closest<HTMLElement>('[data-slot="sheet-content"]')
      const target = event.target
      if (target instanceof Node && content?.contains(target)) {
        return
      }
      if (isWorkspaceBoardKeepOpenTarget(target)) {
        return
      }
      clearSelection()
    }
    document.addEventListener('pointerdown', clearSelectionOutsideBoard, true)
    return () => document.removeEventListener('pointerdown', clearSelectionOutsideBoard, true)
  }, [boardRef, clearSelection, open, selectedCount])
  return renderCards
}
