import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceStatus } from '../../../../shared/types'

export function useWorkspaceKanbanCreateWorktree(): {
  canCreateWorktree: boolean
  createWorktreeForStatus: (workspaceStatus: WorkspaceStatus) => void
} {
  const openModal = useAppStore((s) => s.openModal)
  const canCreateWorktree = useAppStore((s) => s.repos.length > 0)

  const createWorktreeForStatus = useCallback(
    (workspaceStatus: WorkspaceStatus) => {
      openModal('new-workspace-composer', {
        telemetrySource: 'sidebar',
        initialWorkspaceStatus: workspaceStatus
      })
    },
    [openModal]
  )

  return { canCreateWorktree, createWorktreeForStatus }
}
