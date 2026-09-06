import { useAppStore } from '@/store'
import { getRepoMapFromState } from '@/store/selectors'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { buildVisibleWorktreeOptionsFromState, computeVisibleWorktrees } from './visible-worktrees'

/**
 * Filter-only visibility for one worktree id: runs the sidebar filter pipeline
 * without collapse elision or rendered order, so a target inside a collapsed
 * group is not misreported as hidden by filters.
 *
 * Worktree ids are not host-qualified (STA-4343): the same id can name a
 * workspace on two hosts, so an id-only match would let a host-filtered remote
 * target pass on the strength of its visible local twin. When the caller knows
 * the target's host, the visible twin must resolve to that host too.
 */
export function worktreePassesSidebarFilters(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  const state = useAppStore.getState()
  const repoMap = getRepoMapFromState(state)
  const requestedHostId = executionHostId ? normalizeExecutionHostId(executionHostId) : null
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  return computeVisibleWorktrees(
    state.worktreesByRepo,
    [],
    buildVisibleWorktreeOptionsFromState(state, repoMap)
  ).some((worktree) => {
    if (worktree.id !== worktreeId) {
      return false
    }
    if (!requestedHostId) {
      return true
    }
    const hostId = getWorktreeExecutionHostId(worktree, repoMap.get(worktree.repoId), defaultHostId)
    return normalizeExecutionHostId(hostId) === requestedHostId
  })
}
