import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getWorktreeLineageRuntimeOwner } from '../../../../../../shared/resolved-worktree-lineage'
import type { WorktreeLineageUpdateResult } from '../listing/worktree-slice-types'
import { getRepoHostSummaries, worktreeMatchesHost } from '../listing/worktree-host-ownership'

export function getLineageUpdateOwnership(
  state: AppState,
  worktreeId: string,
  result: WorktreeLineageUpdateResult,
  executionHostId?: ExecutionHostId
) {
  const belongsToOwner = (worktree: Worktree): boolean => {
    if (result.target.kind !== 'local') {
      return getWorktreeLineageRuntimeOwner(worktree) === result.target.environmentId
    }
    if (getWorktreeLineageRuntimeOwner(worktree)) {
      return false
    }
    const owner = getRepoHostSummaries(state.repos).get(worktree.repoId)
    return (
      !executionHostId ||
      worktreeMatchesHost(worktree, executionHostId, {
        unhostedWorktreesMatchHost: owner
          ? owner.count === 1 && owner.onlyHostId === executionHostId
          : undefined
      })
    )
  }
  const instances = new Set<string | undefined>()
  const otherInstances = new Set<string | undefined>()
  for (const rows of Object.values(state.worktreesByRepo)) {
    for (const worktree of rows) {
      if (worktree.id === worktreeId) {
        ;(belongsToOwner(worktree) ? instances : otherInstances).add(worktree.instanceId)
      }
    }
  }
  const belongsElsewhere = (instanceId: string | null | undefined): boolean =>
    Boolean(instanceId && otherInstances.has(instanceId) && !instances.has(instanceId))
  // Preserve another host's compatibility-map entry; the mutated owner gets inline lineage.
  return {
    belongsToOwner,
    preserveExisting: belongsElsewhere(state.worktreeLineageById[worktreeId]?.worktreeInstanceId),
    preserveWorkspaceEdge: belongsElsewhere(
      state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]?.childInstanceId
    )
  }
}
