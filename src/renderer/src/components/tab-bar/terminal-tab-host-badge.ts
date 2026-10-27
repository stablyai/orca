import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import type { AppState } from '../../store/types'
import { findWorktreeById } from '../../store/slices/worktree-helpers'
import { selectWorktreesByRepo } from '../../store/workspace-record-selectors'
import { isWorktreeOwnHost } from './tab-bar-host-terminal-targets'

/** The host a terminal tab runs on, named only when it is not its worktree's own host. */
export function selectTerminalTabHostBadgeLabel(
  state: AppState,
  worktreeId: string,
  unifiedTabId: string
): string | null {
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === unifiedTabId)
  // Why gate on the setup id: only the "+" host menu sets it, so every other tab exits here.
  if (!tab?.executionHostId || !tab.projectHostSetupId) {
    return null
  }
  const worktree = findWorktreeById(selectWorktreesByRepo(state), worktreeId)
  if (!worktree) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  if (isWorktreeOwnHost(tab.executionHostId, worktree, repo)) {
    return null
  }
  return selectExecutionHostDisplayLabel(state, tab.executionHostId)
}
