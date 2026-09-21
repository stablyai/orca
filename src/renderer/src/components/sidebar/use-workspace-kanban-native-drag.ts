import { useCallback, useState } from 'react'
import { hasWorkspaceDragData, readWorkspaceDragDataIds } from './workspace-status'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'

export function useWorkspaceKanbanNativeDrag(
  dropWorktreesAtEndOfStatus: (worktreeIds: readonly string[], status: WorkspaceStatus) => void
) {
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)
  const handleDragOver = useCallback((event: React.DragEvent, status: WorkspaceStatus) => {
    if (!hasWorkspaceDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverStatus(status)
  }, [])
  const handleDragLeave = useCallback((event: React.DragEvent) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setDragOverStatus(null)
  }, [])
  const handlePinDragOver = useCallback((event: React.DragEvent) => {
    if (!hasWorkspaceDragData(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setPinDragOver(true)
  }, [])
  const handlePinDragLeave = useCallback((event: React.DragEvent) => {
    const relatedTarget = event.relatedTarget
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return
    }
    setPinDragOver(false)
  }, [])
  const handleDragFinish = useCallback(() => {
    setDragOverStatus(null)
    setPinDragOver(false)
  }, [])
  const handleDrop = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      const worktreeIds = readWorkspaceDragDataIds(event.dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }
      event.preventDefault()
      setDragOverStatus(null)
      dropWorktreesAtEndOfStatus(worktreeIds, status)
    },
    [dropWorktreesAtEndOfStatus]
  )
  return {
    dragOverStatus,
    handleDragFinish,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handlePinDragLeave,
    handlePinDragOver,
    pinDragOver,
    setDragOverStatus,
    setPinDragOver
  }
}
