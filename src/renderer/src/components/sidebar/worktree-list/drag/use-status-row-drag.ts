import { useCallback, useMemo } from 'react'
import type React from 'react'
import type { WorkspaceStatus } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'
import type { WorktreeGroupBy } from '../grouping/row-types'
import { hasWorkspaceDragData, readWorkspaceDragDataIds } from '../../workspace-status'
import { useWorkspaceStatusDocumentDrop } from '../../use-workspace-status-drop'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import type { WorktreeDragSession } from './use-session'
import type { WorktreeDragRuntime } from './use-runtime'
import { getWorkspaceStatusTargetGroupKey } from './status-target'

// Drag-and-drop onto a status section header or a status-grouped row, including the
// document-level fallback used when the pointer leaves the sidebar mid-drag.
export function useWorkspaceStatusRowDrag(args: {
  ctx: WorktreeDropCommitContext
  session: WorktreeDragSession
  runtime: WorktreeDragRuntime
  scrollRef: React.RefObject<HTMLDivElement | null>
  rows: HostSectionRow[]
  groupBy: WorktreeGroupBy
  onMoveWorktreeToStatus: (worktreeId: string, status: WorkspaceStatus) => void
  onPinWorktree: (worktreeId: string) => void
}) {
  const { ctx, session, runtime, scrollRef, rows, groupBy } = args
  const { setDragOverStatus, setDragOverStatusGroupKey, setPinDragOver, clearWorktreeDrag } =
    runtime

  const hasWorkspaceDropTargets = useMemo(
    () =>
      groupBy === 'workspace-status' ||
      rows.some(
        (row) =>
          row.type === 'header' &&
          (row.groupKind === 'workspace-status' || row.key === PINNED_GROUP_KEY)
      ),
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
      setDragOverStatusGroupKey(
        event.currentTarget.getAttribute('data-workspace-status-group-key') ?? null
      )
    },
    [setDragOverStatus, setDragOverStatusGroupKey]
  )

  const handleWorkspaceStatusDragLeave = useCallback(
    (event: React.DragEvent) => {
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
        return
      }
      setDragOverStatus(null)
      setDragOverStatusGroupKey(null)
    },
    [setDragOverStatus, setDragOverStatusGroupKey]
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
    setDragOverStatusGroupKey(null)
    setPinDragOver(false)
  }, [setDragOverStatus, setDragOverStatusGroupKey, setPinDragOver])

  const handleWorkspaceStatusDrop = useCallback(
    (event: React.DragEvent, status: WorkspaceStatus) => {
      const worktreeIds = readWorkspaceDragDataIds(event.dataTransfer)
      if (worktreeIds.length === 0) {
        return
      }
      event.preventDefault()
      const dragSession = session.worktreeDragSessionRef.current
      const targetGroupKey = dragSession
        ? (event.currentTarget.getAttribute('data-workspace-status-group-key') ??
          getWorkspaceStatusTargetGroupKey({
            sourceGroupKey: dragSession.sourceGroupKey,
            status,
            workspaceStatuses: ctx.workspaceStatuses
          }))
        : null
      const statusDrop = dragSession
        ? ctx.computeWorktreeStatusDrop({
            pointerY: event.clientY,
            status,
            groupKey: targetGroupKey,
            draggedIds: dragSession.reorderDraggedIds
          })
        : null
      setDragOverStatus(null)
      setDragOverStatusGroupKey(null)
      if (dragSession && statusDrop && targetGroupKey) {
        event.stopPropagation()
        ctx.onMoveWorktreesToStatusAtIndex({
          worktreeIds: dragSession.reorderDraggedIds,
          status,
          targetGroupKey,
          dropIndex: statusDrop.dropIndex,
          groups: ctx.worktreeDragGroups
        })
        clearWorktreeDrag()
        return
      }
      // Match status-drop scope to drag-preview scope (#9083): session uses its expanded set, else expand dataTransfer ids live.
      ctx.onMoveWorktreesToStatus(
        dragSession ? dragSession.reorderDraggedIds : session.getReorderDraggedIds(worktreeIds),
        status
      )
    },
    [clearWorktreeDrag, ctx, session, setDragOverStatus, setDragOverStatusGroupKey]
  )

  // Why: expand here (not the shared hook, used by the flat board) so a dropped parent carries its lineage children (#9083).
  const moveWorktreesToStatusForDocumentDrop = useCallback(
    (ids: readonly string[], status: WorkspaceStatus) =>
      ctx.onMoveWorktreesToStatus(session.getReorderDraggedIds(ids), status),
    [ctx, session]
  )

  useWorkspaceStatusDocumentDrop(
    scrollRef,
    args.onMoveWorktreeToStatus,
    args.onPinWorktree,
    handleWorkspaceStatusDragFinish,
    hasWorkspaceDropTargets,
    {
      onMoveWorktreesToStatus: moveWorktreesToStatusForDocumentDrop,
      onPinWorktrees: ctx.onPinWorktrees
    }
  )

  return {
    handleWorkspaceStatusDragOver,
    handleWorkspaceStatusDragLeave,
    handleWorkspacePinDragOver,
    handleWorkspacePinDragLeave,
    handleWorkspaceStatusDrop
  }
}
