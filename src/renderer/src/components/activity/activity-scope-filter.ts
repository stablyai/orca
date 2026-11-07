import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace
} from '../../../../shared/worktree/workspace-kinds'
import { isWorkspaceOwnedBySomeoneElse } from '../../../../shared/workspace-creator-visibility'
import type { AgentPaneThread } from './activity-thread-types'

/** Persisted Agents scope, independent of workspace navigation; null hosts and empty repo IDs mean all. */
export type ActivityScopeFilter = {
  visibleHostIds: readonly ExecutionHostId[] | null
  filterRepoIds: readonly string[]
  defaultHostId: ExecutionHostId
  hideWorkspacesFromOtherDevices: boolean
  /** Only read when hideWorkspacesFromOtherDevices is on. */
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
}

function isActivityScopeActive(scope: ActivityScopeFilter): boolean {
  return (
    scope.visibleHostIds !== null ||
    scope.filterRepoIds.length > 0 ||
    scope.hideWorkspacesFromOtherDevices ||
    scope.hideAutomationGeneratedWorkspaces ||
    scope.hideCliCreatedWorkspaces
  )
}

/** Repo ids that still exist; stale persisted ids must not count as an active filter. */
export function resolveActivityScopeRepoIds(
  filterRepoIds: readonly string[],
  repoMap: ReadonlyMap<string, Repo>
): string[] {
  return filterRepoIds.filter((id) => repoMap.has(id.slice(id.indexOf('\0') + 1)))
}

/** Preserve the input array identity when scope hides nothing so downstream memos can reuse results. */
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
  if (!isActivityScopeActive(scope)) {
    return { threads, matchingThreads: threads, hiddenCount: 0 }
  }
  const matchingThreads: AgentPaneThread[] = []
  const visibleThreads: AgentPaneThread[] = []
  const matches = createActivityScopeMatcher(scope)
  for (const thread of threads) {
    if (matches(thread)) {
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
  return createActivityScopeMatcher(scope)(thread)
}

function createActivityScopeMatcher(
  scope: ActivityScopeFilter
): (thread: AgentPaneThread) => boolean {
  const matchesRepo = projectRepoFilterMatcher(scope.filterRepoIds)
  const visibleHosts = scope.visibleHostIds ? new Set(scope.visibleHostIds) : null
  return (thread) => {
    if (visibleHosts) {
      const hostId = getWorktreeExecutionHostId(
        thread.worktree,
        thread.repo ?? undefined,
        scope.defaultHostId
      )
      if (!visibleHosts.has(hostId)) {
        return false
      }
    }
    // Why: repo-less terminal buckets have no project, so a project scope hides them.
    if (scope.filterRepoIds.length > 0) {
      if (
        !thread.repo ||
        !matchesRepo(thread.repo.id, thread.worktree.hostId ?? getRepoExecutionHostId(thread.repo))
      ) {
        return false
      }
    }
    // Synthetic floating/standalone worktrees carry no provenance, so these never hide them.
    if (
      scope.hideAutomationGeneratedWorkspaces &&
      isAutomationGeneratedWorkspace(thread.worktree)
    ) {
      return false
    }
    if (scope.hideCliCreatedWorkspaces && isCliCreatedWorkspace(thread.worktree)) {
      return false
    }
    if (
      scope.hideWorkspacesFromOtherDevices &&
      isWorkspaceOwnedBySomeoneElse(thread.worktree, scope.pairedDeviceIdsByEnvironment)
    ) {
      return false
    }
    return true
  }
}
