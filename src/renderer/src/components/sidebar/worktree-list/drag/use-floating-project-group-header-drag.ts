import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type {
  ProjectGroupHeaderDragController,
  UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import { useProjectGroupHeaderDrag } from './project-group-header-drag'
import {
  createSidebarDragPreview,
  updateSidebarDragPreviewPosition
} from './worktree-sidebar-pointer-drag-dom'

type FloatingDrag = {
  sourceRow: HTMLElement
  pointer: { pointerX: number; pointerY: number }
  shown: ReturnType<typeof createSidebarDragPreview> | null
  release: () => void
}

/** A header drag that carries a floating copy of its row, as workspace rows do, with the others sliding open. */
export function useFloatingProjectGroupHeaderDrag(
  args: Omit<UseProjectGroupHeaderDragArgs, 'floatingPreview'>
): ProjectGroupHeaderDragController {
  const drag = useProjectGroupHeaderDrag({ ...args, floatingPreview: true })
  const floatingRef = useRef<FloatingDrag | null>(null)
  const { onHandlePointerDown } = drag
  const draggingGroupId = drag.state.draggingGroupId
  useEffect(() => {
    const floating = floatingRef.current
    if (draggingGroupId === null || !floating) {
      return
    }
    // Drawn where the drag began moving, then it follows the pointer.
    floating.shown = createSidebarDragPreview({
      sourceRow: floating.sourceRow,
      ...floating.pointer,
      draggedCount: 1
    })
    updateSidebarDragPreviewPosition({ ...floating.shown, ...floating.pointer })
    return () => {
      floating.shown?.preview.remove()
      floating.shown = null
    }
  }, [draggingGroupId])
  useEffect(() => () => floatingRef.current?.release(), [])
  const onFloatingHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, groupId: string) => {
      floatingRef.current?.release()
      const onMove = (move: PointerEvent): void => {
        floating.pointer = { pointerX: move.clientX, pointerY: move.clientY }
        if (floating.shown) {
          updateSidebarDragPreviewPosition({ ...floating.shown, ...floating.pointer })
        }
      }
      const release = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', release)
        window.removeEventListener('pointercancel', release)
      }
      const floating: FloatingDrag = {
        sourceRow: event.currentTarget,
        pointer: { pointerX: event.clientX, pointerY: event.clientY },
        shown: null,
        release
      }
      floatingRef.current = floating
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', release)
      window.addEventListener('pointercancel', release)
      onHandlePointerDown(event, groupId)
    },
    [onHandlePointerDown]
  )
  return { state: drag.state, onHandlePointerDown: onFloatingHandlePointerDown }
}
