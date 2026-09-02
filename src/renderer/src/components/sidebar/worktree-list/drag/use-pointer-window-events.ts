import { useEffect } from 'react'
import type { WorktreeDragRuntime } from './use-runtime'
import type {
  WorktreeDropCommitContext,
  WorktreeStatusDropAtIndexArgs
} from './drop-commit-context'
import { commitWorktreePointerDrop } from './pointer-commit'
import type { WorktreePointerDrag } from './row-state'

const SIDEBAR_POINTER_DRAG_THRESHOLD_PX = 4

// Pointer drags escape the row that started them, so move/up/cancel are tracked on the
// window in capture phase.
export function useWorktreePointerDragWindowEvents(args: {
  ctx: WorktreeDropCommitContext
  runtime: WorktreeDragRuntime
  beginWorktreePointerDrag: (drag: WorktreePointerDrag) => void
  scheduleWorktreePointerDragFrame: (drag: WorktreePointerDrag) => void
  onWorkspaceBoardDragPreviewCommit: () => void
  onDropWorktreesOnWorkspaceBoard: (dropArgs: WorktreeStatusDropAtIndexArgs) => void
}): void {
  const {
    ctx,
    beginWorktreePointerDrag,
    scheduleWorktreePointerDragFrame,
    onWorkspaceBoardDragPreviewCommit,
    onDropWorktreesOnWorkspaceBoard
  } = args
  const { worktreePointerDragRef, clearWorktreeDrag } = args.runtime

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      drag.currentX = event.clientX
      drag.currentY = event.clientY
      if (!drag.active) {
        const distance = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY)
        if (distance < SIDEBAR_POINTER_DRAG_THRESHOLD_PX) {
          return
        }
        beginWorktreePointerDrag(drag)
      }
      event.preventDefault()
      event.stopPropagation()
      scheduleWorktreePointerDragFrame(drag)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      drag.currentX = event.clientX
      drag.currentY = event.clientY
      if (!drag.active) {
        worktreePointerDragRef.current = null
        return
      }
      event.preventDefault()
      event.stopPropagation()
      commitWorktreePointerDrop({
        event,
        drag,
        ctx,
        onWorkspaceBoardDragPreviewCommit,
        onDropWorktreesOnWorkspaceBoard
      })
    }

    const handlePointerCancel = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      clearWorktreeDrag()
    }

    window.addEventListener('pointermove', handlePointerMove, { capture: true })
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, { capture: true })
      window.removeEventListener('pointerup', handlePointerUp, { capture: true })
      window.removeEventListener('pointercancel', handlePointerCancel, { capture: true })
    }
  }, [
    beginWorktreePointerDrag,
    clearWorktreeDrag,
    ctx,
    onDropWorktreesOnWorkspaceBoard,
    onWorkspaceBoardDragPreviewCommit,
    scheduleWorktreePointerDragFrame,
    worktreePointerDragRef
  ])
}
