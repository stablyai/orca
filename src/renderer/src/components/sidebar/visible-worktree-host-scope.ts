import {
  ALL_EXECUTION_HOSTS_SCOPE,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'

/**
 * Which execution hosts the sidebar is currently scoped to, and whether a row
 * belongs to one of them. Split out of visible-worktrees for the line cap.
 */
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

/**
 * Called by WorktreeList after computing visible worktrees so the Cmd+1–9
 * handler can read the exact same ordering the user sees on screen. Pass null
 * on unmount.
 */
