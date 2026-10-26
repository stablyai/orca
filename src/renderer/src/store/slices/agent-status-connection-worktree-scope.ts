import type { AppState } from '../types'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId
} from '../../../../shared/execution-host'
import { selectWorktreesByRepo } from '../workspace-record-selectors'

// Resolve unstamped SSH rows via canonical hostId-first worktree ownership (#9030). Clear only unambiguous connection IDs: repoId::path collides across hosts, and teardown must not hide sibling status.
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
  for (const [repoId, worktrees] of Object.entries(selectWorktreesByRepo(state))) {
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
