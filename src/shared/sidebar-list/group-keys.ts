import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { UNGROUPED_PROJECT_GROUP_KEY } from '../project-groups'

export {
  PR_GROUP_ORDER,
  getPRLaneKey,
  type PRGroupKey
} from '../workspace-view/workspace-pr-groups'

export function getProjectGroupHeaderKey(groupId: string | null): string {
  return groupId ? `project-group:${groupId}` : UNGROUPED_PROJECT_GROUP_KEY
}

export const PINNED_GROUP_KEY = 'pinned'

export const ALL_GROUP_KEY = 'all'

export const LINEAGE_GROUP_PREFIX = 'lineage:'

export function getLineageGroupKey(worktreeId: string): string {
  return `${LINEAGE_GROUP_PREFIX}${worktreeId}`
}

export function getWorktreeLineageGroupKey(worktree: Pick<Worktree, 'id' | 'hostId'>): string {
  return getLineageGroupKey(worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id)
}
