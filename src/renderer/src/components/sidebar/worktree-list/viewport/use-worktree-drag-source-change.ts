import { useEffect } from 'react'
import type { WorktreeRowDragState } from '../drag/row-state'

export function useWorktreeDragSourceChange(
  dragState: WorktreeRowDragState,
  onWorktreeDragSourceChange: (sourceGroupKey: string | null, worktreeId: string | null) => void
): void {
  useEffect(() => {
    onWorktreeDragSourceChange(dragState.sourceGroupKey, dragState.draggingWorktreeId)
  }, [dragState.draggingWorktreeId, dragState.sourceGroupKey, onWorktreeDragSourceChange])
  useEffect(
    () => () => {
      onWorktreeDragSourceChange(null, null)
    },
    [onWorktreeDragSourceChange]
  )
}
