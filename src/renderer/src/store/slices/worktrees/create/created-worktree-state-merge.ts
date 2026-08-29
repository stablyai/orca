import type { WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { CreateWorktreeResult } from '../../../../../../shared/worktree/create-types'
import {
  getProjectHostSetupForRepoHost,
  repoHostId,
  withRepoHostOwnership
} from '../listing/worktree-host-ownership'

/** Folds a fresh create result into the worktree, lineage and base-status maps. */
export function applyCreatedWorktree(
  set: WorktreeSliceSet,
  repoId: string,
  result: CreateWorktreeResult
) {
  // Why: worktrees.onChanged can add this worktree before this callback runs; appending blindly would duplicate it (React key clash).
  set((s) => {
    const hostId = repoHostId(s, repoId)
    const createdWorktree = withRepoHostOwnership(
      result.worktree,
      hostId,
      getProjectHostSetupForRepoHost(s, repoId, hostId)
    )
    const current = s.worktreesByRepo[repoId] ?? []
    const alreadyPresent = current.some((w) => w.id === createdWorktree.id)
    const nextWorktrees = alreadyPresent
      ? current.map((worktree) =>
          worktree.id === createdWorktree.id ? { ...worktree, ...createdWorktree } : worktree
        )
      : [...current, createdWorktree]
    return {
      worktreesByRepo: {
        ...s.worktreesByRepo,
        [repoId]: nextWorktrees
      },
      ...(result.workspaceLineage
        ? {
            workspaceLineageByChildKey: {
              ...s.workspaceLineageByChildKey,
              [result.workspaceLineage.childWorkspaceKey]: result.workspaceLineage
            }
          }
        : {}),
      ...(result.lineage
        ? {
            worktreeLineageById: {
              ...s.worktreeLineageById,
              [result.lineage.worktreeId]: result.lineage
            }
          }
        : {}),
      ...(result.initialBaseStatus
        ? {
            baseStatusByWorktreeId: {
              ...s.baseStatusByWorktreeId,
              [result.worktree.id]:
                s.baseStatusByWorktreeId[result.worktree.id] ?? result.initialBaseStatus
            }
          }
        : {}),
      sortEpoch: s.sortEpoch + 1
    }
  })
}
