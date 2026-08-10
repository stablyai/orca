import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { Repo, Worktree } from '../../../../shared/types'

export function resolveRepoForWorktreeTarget(
  repos: readonly Repo[],
  target: Pick<Worktree, 'repoId' | 'hostId'>
): Repo | null {
  const matching = repos.filter((entry) => entry.id === target.repoId)
  if (target.hostId) {
    return findRepoForHost(matching, target.repoId, { hostId: target.hostId })
  }
  return matching.length === 1 ? matching[0] : null
}
