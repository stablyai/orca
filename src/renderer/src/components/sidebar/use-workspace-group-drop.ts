import { useCallback, useState } from 'react'
import type React from 'react'
import type { WorkspaceGroupId } from '../../../../shared/types'
import { hasWorkspaceDragData, readWorkspaceDragDataIds } from './workspace-status'

export function useWorkspaceGroupDrop({
  onAssign,
  groupId
}: {
  onAssign: (worktreeIds: readonly string[], groupId: WorkspaceGroupId | null) => void
  groupId: WorkspaceGroupId | null
}): {
  isOver: boolean
  bind: React.HTMLAttributes<HTMLElement>
} {
  const [isOver, setIsOver] = useState(false)

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasWorkspaceDragData(e.dataTransfer)) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsOver(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation()
    setIsOver(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!hasWorkspaceDragData(e.dataTransfer)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setIsOver(false)
      const ids = readWorkspaceDragDataIds(e.dataTransfer)
      if (ids.length === 0) {
        return
      }
      onAssign(ids, groupId)
    },
    [onAssign, groupId]
  )

  return {
    isOver,
    bind: { onDragOver, onDragLeave, onDrop }
  }
}
