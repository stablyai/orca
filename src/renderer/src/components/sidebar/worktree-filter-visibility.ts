import { useAppStore } from '@/store'
import { getRepoMapFromState } from '@/store/selectors'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { computeVisibleWorktrees } from './visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from './visible-worktree-options-from-state'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

/** Check filters without collapse/order elision; a known host must match so a visible twin cannot qualify another host. */
export function worktreePassesSidebarFilters(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): boolean {
  const state = useAppStore.getState()
  const repoMap = getRepoMapFromState(state)
  const requestedHostId = executionHostId ? normalizeExecutionHostId(executionHostId) : null
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  return computeVisibleWorktrees(
    selectWorktreesByRepo(state),
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
