import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { getWorkspaceStatus } from './workspace-status'
import { makeWorkspaceStatusId } from '../../../../shared/workspace-statuses'
import type { Worktree } from '../../../../shared/worktree/types'

type WorkspaceStatuses = ReturnType<typeof useAppStore.getState>['workspaceStatuses']

export function useWorkspaceKanbanStatusActions(args: {
  allWorktrees: readonly Worktree[]
  workspaceStatuses: WorkspaceStatuses
  setWorkspaceStatuses: (statuses: WorkspaceStatuses) => void
  updateWorktreeMeta: ReturnType<typeof useAppStore.getState>['updateWorktreeMeta']
}) {
  const recordInteraction = (): void => {
    useAppStore.getState().recordFeatureInteraction('workspace-board-actions')
  }
  const handleRenameStatus = useCallback(
    (statusId: string, label: string) => {
      const trimmed = label.trim()
      if (!trimmed) {
        return
      }
      args.setWorkspaceStatuses(
        args.workspaceStatuses.map((status) =>
          status.id === statusId ? { ...status, label: trimmed } : status
        )
      )
      recordInteraction()
    },
    [args]
  )
  const handleChangeStatusColor = useCallback(
    (statusId: string, color: string) => {
      args.setWorkspaceStatuses(
        args.workspaceStatuses.map((status) =>
          status.id === statusId ? { ...status, color } : status
        )
      )
      recordInteraction()
    },
    [args]
  )
  const handleChangeStatusIcon = useCallback(
    (statusId: string, icon: string) => {
      args.setWorkspaceStatuses(
        args.workspaceStatuses.map((status) =>
          status.id === statusId ? { ...status, icon } : status
        )
      )
      recordInteraction()
    },
    [args]
  )
  const handleMoveStatus = useCallback(
    (statusId: string, direction: -1 | 1) => {
      const index = args.workspaceStatuses.findIndex((status) => status.id === statusId)
      const nextIndex = index + direction
      if (index === -1 || nextIndex < 0 || nextIndex >= args.workspaceStatuses.length) {
        return
      }
      const next = [...args.workspaceStatuses]
      const [moved] = next.splice(index, 1)
      next.splice(nextIndex, 0, moved)
      args.setWorkspaceStatuses(next)
      recordInteraction()
    },
    [args]
  )
  const handleAddStatus = useCallback(() => {
    const label = `Status ${args.workspaceStatuses.length + 1}`
    args.setWorkspaceStatuses([
      ...args.workspaceStatuses,
      { id: makeWorkspaceStatusId(label, args.workspaceStatuses), label }
    ])
    recordInteraction()
  }, [args])
  const handleRemoveStatus = useCallback(
    (statusId: string) => {
      if (args.workspaceStatuses.length <= 1) {
        return
      }
      const index = args.workspaceStatuses.findIndex((status) => status.id === statusId)
      if (index === -1) {
        return
      }
      const next = args.workspaceStatuses.filter((status) => status.id !== statusId)
      const fallbackStatus = next[Math.min(index, next.length - 1)]?.id ?? next[0]!.id
      args.setWorkspaceStatuses(next)
      recordInteraction()
      for (const worktree of args.allWorktrees) {
        if (getWorkspaceStatus(worktree, args.workspaceStatuses) === statusId) {
          void args.updateWorktreeMeta(worktree.id, { workspaceStatus: fallbackStatus })
        }
      }
    },
    [args]
  )
  return {
    handleRenameStatus,
    handleChangeStatusColor,
    handleChangeStatusIcon,
    handleMoveStatus,
    handleAddStatus,
    handleRemoveStatus
  }
}
