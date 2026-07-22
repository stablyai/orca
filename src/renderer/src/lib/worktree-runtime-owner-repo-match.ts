import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/types'
import { splitWorktreeId } from '../../../shared/worktree-id'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { findIndexedRepoOwners } from './worktree-runtime-owner-index'

type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> &
  Partial<Pick<Repo, 'path'>>

function countSharedPathSegments(repoPath: string, worktreePath: string): number {
  const repoSegments = normalizeRuntimePathForComparison(repoPath).split('/').filter(Boolean)
  const worktreeSegments = normalizeRuntimePathForComparison(worktreePath)
    .split('/')
    .filter(Boolean)
  let shared = 0
  const limit = Math.min(repoSegments.length, worktreeSegments.length)
  while (shared < limit && repoSegments[shared] === worktreeSegments[shared]) {
    shared += 1
  }
  return shared
}

// Why: one project can be registered on both local and a paired runtime under a
// shared repoId (#8484). When a worktree carries no explicit hostId, resolve the
// owning repo record by the worktree's own filesystem path so it routes to the
// host that owns it, not the first-indexed record or the global default runtime.
export function findRepoOwnerRecordForWorktree(
  repos: readonly RepoOwnerRecord[] | undefined,
  worktreeId: string,
  repoId: string
): RepoOwnerRecord | null {
  const matches = findIndexedRepoOwners(repos, repoId)
  if (matches.length <= 1) {
    return matches[0] ?? null
  }
  const worktreePath = splitWorktreeId(worktreeId)?.worktreePath?.trim()
  if (worktreePath) {
    const scored = matches
      .map((repo) => ({
        repo,
        score: repo.path?.trim() ? countSharedPathSegments(repo.path, worktreePath) : 0
      }))
      .filter((entry) => entry.score > 0)
    const topScore = scored.reduce((max, entry) => Math.max(max, entry.score), 0)
    const leaders = scored.filter((entry) => entry.score === topScore)
    const leaderHostIds = new Set(leaders.map((entry) => getRepoExecutionHostId(entry.repo)))
    // Only trust the path match when it points at a single host; a cross-host
    // tie stays ambiguous and defers to the prior first-indexed behavior.
    if (leaders.length > 0 && leaderHostIds.size === 1) {
      return leaders[0].repo
    }
  }
  return matches[0] ?? null
}
