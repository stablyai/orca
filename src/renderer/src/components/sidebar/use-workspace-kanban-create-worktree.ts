import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceStatus } from '../../../../shared/worktree/types'

export function useWorkspaceKanbanCreateWorktree(): {
  createWorktreeForStatus: (workspaceStatus: WorkspaceStatus) => void
} {
  const openModal = useAppStore((s) => s.openModal)

  const createWorktreeForStatus = useCallback(
    (workspaceStatus: WorkspaceStatus) => {
      openModal('new-workspace-composer', {
        telemetrySource: 'sidebar',
        initialWorkspaceStatus: workspaceStatus
      })
    },
    [openModal]
  )

  return { createWorktreeForStatus }
}
