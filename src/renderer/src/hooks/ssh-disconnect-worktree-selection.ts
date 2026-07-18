import { getRepoExecutionHostId, toSshExecutionHostId } from '../../../shared/execution-host'
import type { Repo, Worktree } from '../../../shared/types'

type SshDisconnectWorktreeState = {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktreesByRepo: Record<string, readonly Pick<Worktree, 'id' | 'hostId'>[]>
}

/**
 * Collects worktrees owned by one disconnected SSH target without crossing host boundaries.
 *
 * @param state Repository and worktree ownership currently known by the renderer.
 * @param targetId SSH target whose live workspace state should be cleared.
 * @returns Worktree IDs attributable to the disconnected target.
 */
export function getSshDisconnectWorktreeIds(
  state: SshDisconnectWorktreeState,
  targetId: string
): Set<string> {
  const targetHostId = toSshExecutionHostId(targetId)
  const allHostIdsByRepo = new Map<string, Set<string>>()
  const targetHostIdsByRepo = new Map<string, Set<string>>()
  for (const repo of state.repos) {
    const hostId = getRepoExecutionHostId(repo)
    const allHostIds = allHostIdsByRepo.get(repo.id) ?? new Set<string>()
    allHostIds.add(hostId)
    allHostIdsByRepo.set(repo.id, allHostIds)
    if (hostId === targetHostId) {
      const targetHostIds = targetHostIdsByRepo.get(repo.id) ?? new Set<string>()
      targetHostIds.add(hostId)
      targetHostIdsByRepo.set(repo.id, targetHostIds)
    }
  }

  const worktreeIds = new Set<string>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
    const targetHostIds = targetHostIdsByRepo.get(repoId)
    if (!targetHostIds) {
      continue
    }
    const allHostIds = allHostIdsByRepo.get(repoId)
    const soleHostId = allHostIds?.size === 1 ? allHostIds.values().next().value : undefined
    const legacyRowsBelongToTarget = soleHostId ? targetHostIds.has(soleHostId) : false
    for (const worktree of worktrees) {
      // Why: old persisted worktrees may not have hostId. Attribute those only
      // when the repo has one owner; duplicate repo ids must never be guessed.
      if (
        (worktree.hostId && targetHostIds.has(worktree.hostId)) ||
        (!worktree.hostId && legacyRowsBelongToTarget)
      ) {
        worktreeIds.add(worktree.id)
      }
    }
  }
  return worktreeIds
}
