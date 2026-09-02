import type { AppState } from '../types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'

// Why: relay/daemon teardown drops main's rows, but renderer entries whose connectionId stamp never
// matched (unstamped over SSH) survive and stay "fresh" 30 min (#9030). Resolve each worktree's host
// via the canonical hostId-first precedence and keep only ids UNAMBIGUOUSLY on this connection — a
// worktree id is `${repoId}::${path}` (no host component), so the same project mirrored at the same
// path on two hosts yields one shared id that must not clear another host's live rows.
export function collectWorktreeIdsForConnection(
  state: AppState,
  connectionId: string
): Set<string> {
  const hostIdsOnConnection = new Set(
    state.repos
      .filter((repo) => repo.connectionId === connectionId)
      .map((repo) => getRepoExecutionHostId(repo))
  )
  if (hostIdsOnConnection.size === 0) {
    return new Set()
  }
  const repoById = new Map(state.repos.map((repo) => [repo.id, repo] as const))
  const onConnection = new Set<string>()
  const onOtherHost = new Set<string>()
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo)) {
    const repo = repoById.get(repoId)
    for (const worktree of worktrees) {
      const bucket = hostIdsOnConnection.has(getWorktreeExecutionHostId(worktree, repo))
        ? onConnection
        : onOtherHost
      bucket.add(worktree.id)
    }
  }
  // A worktree id that also lives on another host is ambiguous — leave it rather than hide a live row.
  for (const id of onOtherHost) {
    onConnection.delete(id)
  }
  return onConnection
}
