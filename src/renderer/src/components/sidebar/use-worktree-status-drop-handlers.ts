import {
  useCallback,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { WorkspaceStatus } from '../../../../shared/types'
import type { HostSectionRow } from './host-section-rows'
import { PINNED_GROUP_KEY, type WorktreeGroupBy } from './worktree-list-groups'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type { WorktreeSidebarDragSession } from './worktree-sidebar-drag-autoscroll'
import type { WorktreeSidebarDropPreview } from './worktree-sidebar-drop-preview'
import { hasWorkspaceDragData, readWorkspaceDragDataIds } from './workspace-status'

type Args = {
  groupBy: WorktreeGroupBy
  rows: readonly HostSectionRow[]
  setDragOverStatus: Dispatch<SetStateAction<WorkspaceStatus | null>>
  setPinDragOver: Dispatch<SetStateAction<boolean>>
  worktreeDragSessionRef: MutableRefObject<WorktreeSidebarDragSession | null>
  computeWorktreeStatusDrop: (args: {
    pointerY: number
    status: WorkspaceStatus
    draggedIds: readonly string[]
  }) => WorktreeSidebarDropPreview | null
  onMoveWorktreesToStatusAtIndex: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
    groups: readonly WorktreeDragGroup[]
  }) => void
  worktreeDragGroups: readonly WorktreeDragGroup[]
  clearWorktreeDrag: () => void
  onMoveWorktreesToStatus: (ids: readonly string[], status: WorkspaceStatus) => void
  getReorderDraggedIds: (ids: readonly string[]) => readonly string[]
}

type Result = {
  hasWorkspaceDropTargets: boolean
  handleWorkspaceStatusDragOver: (event: React.DragEvent, status: WorkspaceStatus) => void
  handleWorkspaceStatusDragLeave: (event: React.DragEvent) => void
  handleWorkspacePinDragOver: (event: React.DragEvent) => void
  handleWorkspacePinDragLeave: (event: React.DragEvent) => void
  handleWorkspaceStatusDragFinish: () => void
  handleWorkspaceStatusDrop: (event: React.DragEvent, status: WorkspaceStatus) => void
}

export function useWorktreeStatusDropHandlers(args: Args): Result {
  const {
    groupBy,
    rows,
    setDragOverStatus,
    setPinDragOver,
    worktreeDragSessionRef,
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
    worktreeDragGroups,
    clearWorktreeDrag,
    onMoveWorktreesToStatus,
    getReorderDraggedIds
  } = args
  const hasWorkspaceDropTargets = useMemo(
    () =>
      groupBy === 'workspace-status' ||
      rows.some((row) => row.type === 'header' && row.key === PINNED_GROUP_KEY),
    [groupBy, rows]
  )
  const handleWorkspaceStatusDragOver = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      if (!hasWorkspaceDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverStatus(status)
    },
    [setDragOverStatus]
  )
  const handleWorkspaceStatusDragLeave = useCallback(
    (event: React.DragEvent) => {
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
        return
      }
      setDragOverStatus(null)
    },
    [setDragOverStatus]
  )
  const handleWorkspacePinDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!hasWorkspaceDragData(event.dataTransfer)) {
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setPinDragOver(true)
    },
    [setPinDragOver]
  )
  const handleWorkspacePinDragLeave = useCallback(
    (event: React.DragEvent) => {
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
        return
      }
      setPinDragOver(false)
    },
    [setPinDragOver]
  )
  const handleWorkspaceStatusDragFinish = useCallback(() => {
    setDragOverStatus(null)
    setPinDragOver(false)
  }, [setDragOverStatus, setPinDragOver])
  const handleWorkspaceStatusDrop = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      const worktreeIds = readWorkspaceDragDataIds(event.dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }
      event.preventDefault()
      const session = worktreeDragSessionRef.current
      const statusDrop = session
        ? computeWorktreeStatusDrop({
            pointerY: event.clientY,
            status,
            draggedIds: session.reorderDraggedIds
          })
        : null
      setDragOverStatus(null)
      if (session && statusDrop) {
        event.stopPropagation()
        onMoveWorktreesToStatusAtIndex({
          worktreeIds: session.reorderDraggedIds,
          status,
          dropIndex: statusDrop.dropIndex,
          groups: worktreeDragGroups
        })
        clearWorktreeDrag()
        return
      }
      // Match status-drop scope to drag-preview scope (#9083): session uses its expanded set, else expand dataTransfer ids live.
      onMoveWorktreesToStatus(
        session ? session.reorderDraggedIds : getReorderDraggedIds(worktreeIds),
        status
      )
    },
    [
      clearWorktreeDrag,
      computeWorktreeStatusDrop,
      getReorderDraggedIds,
      onMoveWorktreesToStatus,
      onMoveWorktreesToStatusAtIndex,
      setDragOverStatus,
      worktreeDragSessionRef,
      worktreeDragGroups
    ]
  )
  return {
    hasWorkspaceDropTargets,
    handleWorkspaceStatusDragOver,
    handleWorkspaceStatusDragLeave,
    handleWorkspacePinDragOver,
    handleWorkspacePinDragLeave,
    handleWorkspaceStatusDragFinish,
    handleWorkspaceStatusDrop
  }
}
