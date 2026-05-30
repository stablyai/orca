import type {
  WorkspaceGroupId,
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../shared/types'
import { getWorkspaceStatus } from './workspace-status'
import { expandWorktreeIdsToGroupMembers } from './workspace-group-actions'

type GroupMemberStatusLookup = Pick<Worktree, 'id' | 'workspaceStatus'> & {
  workspaceGroupId?: WorkspaceGroupId | null
}

export function buildWorkspaceGroupStatusUpdates(args: {
  worktreeIds: readonly string[]
  allWorktrees: readonly GroupMemberStatusLookup[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  targetStatus: WorkspaceStatus
}): Map<string, { workspaceStatus: WorkspaceStatus }> {
  const expandedIds = expandWorktreeIdsToGroupMembers(args.worktreeIds, args.allWorktrees)
  const worktreeById = new Map(args.allWorktrees.map((worktree) => [worktree.id, worktree]))
  const updates = new Map<string, { workspaceStatus: WorkspaceStatus }>()
  for (const worktreeId of expandedIds) {
    const worktree = worktreeById.get(worktreeId)
    if (!worktree || getWorkspaceStatus(worktree, args.workspaceStatuses) === args.targetStatus) {
      continue
    }
    updates.set(worktreeId, { workspaceStatus: args.targetStatus })
  }
  return updates
}
