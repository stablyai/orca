import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/worktree/types'
import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'

export type WorkspaceBoardTaskStatusSyncRequest = {
  worktreeKeys: string[]
  targetStatus: WorkspaceStatusDefinition
}

export function getWorkspaceBoardTaskStatusSyncRequest(args: {
  enabled: boolean
  worktreeKeys: readonly string[]
  status: WorkspaceStatus
  worktreesByKey: ReadonlyMap<string, Pick<Worktree, 'workspaceStatus'>>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): WorkspaceBoardTaskStatusSyncRequest | null {
  if (!args.enabled || args.worktreeKeys.length === 0) {
    return null
  }
  const targetStatus = args.workspaceStatuses.find((item) => item.id === args.status)
  if (!targetStatus) {
    return null
  }
  const changedWorktreeKeys = [...new Set(args.worktreeKeys)].filter((worktreeKey) => {
    const worktree = args.worktreesByKey.get(worktreeKey)
    return worktree ? getWorkspaceStatus(worktree, args.workspaceStatuses) !== args.status : false
  })
  if (changedWorktreeKeys.length === 0) {
    return null
  }
  return { worktreeKeys: changedWorktreeKeys, targetStatus }
}
