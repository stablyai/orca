import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'

/** Null means all hosts; otherwise return the sidebar’s explicit host scope. */
export function getVisibleWorkspaceHostIdSet(
  state: Pick<AppState, 'workspaceHostScope' | 'visibleWorkspaceHostIds'>
): ReadonlySet<ExecutionHostId> | null {
  const hostIds =
    state.visibleWorkspaceHostIds ??
    (state.workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [state.workspaceHostScope])
  return hostIds ? new Set(hostIds) : null
}

export function worktreeMatchesVisibleHost(
  worktree: Worktree,
  visibleHostIds: ReadonlySet<ExecutionHostId> | null,
  repoMap: Map<string, Repo>,
  defaultHostId: ExecutionHostId
): boolean {
  if (!visibleHostIds) {
    return true
  }
  const repo = repoMap.get(worktree.repoId)
  return repo
    ? visibleHostIds.has(getWorktreeExecutionHostId(worktree, repo, defaultHostId))
    : false
}
