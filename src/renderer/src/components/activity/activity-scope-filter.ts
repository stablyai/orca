import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AgentPaneThread } from './activity-thread-types'

/** Host/project scope for the Agents activity surfaces. Persisted and separate
 *  from the workspace-nav filters; hosts `null` = all, repoIds empty = all. */
export type ActivityScopeFilter = {
  visibleHostIds: readonly ExecutionHostId[] | null
  filterRepoIds: readonly string[]
  defaultHostId: ExecutionHostId
}

/** Repo ids that still exist; stale persisted ids must not count as an active filter. */
export function resolveActivityScopeRepoIds(
  filterRepoIds: readonly string[],
  repoMap: ReadonlyMap<string, Repo>
): string[] {
  return filterRepoIds.filter((repoId) => repoMap.has(repoId))
}

/**
 * Apply the scope to a thread list. Returns the input array by identity when
 * the scope is inactive or hides nothing, so downstream memos (visible threads,
 * grouping) see an unchanged dep instead of re-running on every rebuild.
 */
export function filterThreadsByActivityScope(args: {
  threads: AgentPaneThread[]
  scope: ActivityScopeFilter
  /** Kept visible even when scoped out, so changing scope can't vanish the open row. */
  exemptPaneKey: string | null
}): {
  threads: AgentPaneThread[]
  /** Strict matches for bulk actions; excludes a selected row kept visible only by the exemption. */
  matchingThreads: AgentPaneThread[]
  hiddenCount: number
} {
  const { threads, scope, exemptPaneKey } = args
  if (!scope.visibleHostIds && scope.filterRepoIds.length === 0) {
    return { threads, matchingThreads: threads, hiddenCount: 0 }
  }
  const matchingThreads: AgentPaneThread[] = []
  const visibleThreads: AgentPaneThread[] = []
  for (const thread of threads) {
    if (threadMatchesActivityScope(thread, scope)) {
      matchingThreads.push(thread)
      visibleThreads.push(thread)
    } else if (thread.paneKey === exemptPaneKey) {
      visibleThreads.push(thread)
    }
  }
  return {
    threads: visibleThreads.length === threads.length ? threads : visibleThreads,
    matchingThreads: matchingThreads.length === threads.length ? threads : matchingThreads,
    hiddenCount: threads.length - visibleThreads.length
  }
}

export function threadMatchesActivityScope(
  thread: AgentPaneThread,
  scope: ActivityScopeFilter
): boolean {
  if (scope.visibleHostIds) {
    const hostId = getWorktreeExecutionHostId(
      thread.worktree,
      thread.repo ?? undefined,
      scope.defaultHostId
    )
    if (!scope.visibleHostIds.includes(hostId)) {
      return false
    }
  }
  // Why: repo-less terminal buckets have no project, so a project scope hides them.
  if (scope.filterRepoIds.length > 0) {
    if (!thread.repo || !scope.filterRepoIds.includes(thread.repo.id)) {
      return false
    }
  }
  return true
}
