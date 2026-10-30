import { useEffect } from 'react'
import type { WorktreeDragRuntime } from './use-runtime'
import type {
  WorktreeDropCommitContext,
  WorktreeStatusDropAtIndexArgs
} from './drop-commit-context'
import { commitWorktreePointerDrop } from './pointer-commit'
import type { WorktreePointerDrag } from './row-state'
import { addAppKeyListener, removeAppKeyListener } from '@/lib/app-keyboard-router'

const SIDEBAR_POINTER_DRAG_THRESHOLD_PX = 4

// Capture move/up/cancel on window because drags escape their starting row.
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

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !worktreePointerDragRef.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clearWorktreeDrag()
    }

    addAppKeyListener('keydown', handleKeyDown)
    window.addEventListener('pointermove', handlePointerMove, { capture: true })
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    return () => {
      removeAppKeyListener('keydown', handleKeyDown)
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
