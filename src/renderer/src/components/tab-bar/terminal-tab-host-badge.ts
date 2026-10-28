import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { selectKnownWorktreeById } from '@/store/selectors'
import type { AppState } from '../../store/types'
import { isWorktreeOwnHost } from './tab-bar-host-terminal-targets'

export function selectTerminalTabHostBadgeLabel(
  state: AppState,
  worktreeId: string,
  unifiedTabId: string
): string | null {
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === unifiedTabId)
  const worktree = selectKnownWorktreeById(state, worktreeId)
  if (!tab?.executionHostId || !worktree) {
    return null
  }
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  return isWorktreeOwnHost(tab.executionHostId, worktree, repo)
    ? null
    : selectExecutionHostDisplayLabel(state, tab.executionHostId)
}
