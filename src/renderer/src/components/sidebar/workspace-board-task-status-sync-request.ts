import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'

export type WorkspaceBoardTaskStatusSyncRequest = {
  worktreeIds: string[]
  targetStatus: WorkspaceStatusDefinition
}

export function getWorkspaceBoardTaskStatusSyncRequest(args: {
  enabled: boolean
  worktreeIds: readonly string[]
  status: WorkspaceStatus
  worktreesById: ReadonlyMap<string, Pick<Worktree, 'workspaceStatus'>>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): WorkspaceBoardTaskStatusSyncRequest | null {
  if (!args.enabled || args.worktreeIds.length === 0) {
    return null
  }
  const targetStatus = args.workspaceStatuses.find((item) => item.id === args.status)
  if (!targetStatus) {
    return null
  }
  const changedWorktreeIds = [...new Set(args.worktreeIds)].filter((worktreeId) => {
    const worktree = args.worktreesById.get(worktreeId)
    return worktree ? getWorkspaceStatus(worktree, args.workspaceStatuses) !== args.status : false
  })
  return changedWorktreeIds.length > 0 ? { worktreeIds: changedWorktreeIds, targetStatus } : null
}
