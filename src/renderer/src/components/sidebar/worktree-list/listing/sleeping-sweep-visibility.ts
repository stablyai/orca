import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { isSleepingSweepExempt } from '../../../../../../shared/workspace-view/workspace-row-filters'
import { getAgentStatusEpochNow } from '@/lib/agent-status/evidence/agent-status-epoch-clock'
import {
  getWorktreeIdsWithLiveAgent,
  isInactiveWorkspace
} from '@/lib/workspace/activity/worktree-activity-state'
import {
  getVisibleWorktreeBrowserActivityTabs,
  getVisibleWorktreeTerminalActivityTabs,
  getWorktreeIdsWithStructuredChat
} from './visible-worktree-activity-inputs'

/** Whether "Hide sleeping" drops a row, read from the same activity inputs and agent clock as the sidebar. */
export function createSleepingSweepHiddenCheck(
  state: AppState,
  exemptWorktreeIds?: ReadonlySet<string>
): (worktree: Worktree) => boolean {
  const tabsByWorktree = getVisibleWorktreeTerminalActivityTabs(state.tabsByWorktree)
  const browserTabsByWorktree = getVisibleWorktreeBrowserActivityTabs(state.browserTabsByWorktree)
  const liveAgentWorktrees = getWorktreeIdsWithLiveAgent(
    state.agentStatusByPaneKey,
    tabsByWorktree,
    getAgentStatusEpochNow(state.agentStatusEpoch)
  )
  const structuredChatWorktrees = getWorktreeIdsWithStructuredChat(
    state.unifiedTabsByWorktree,
    state.structuredChatSleptAtByPaneKey
  )
  return (worktree) =>
    exemptWorktreeIds?.has(worktree.id) !== true &&
    !isSleepingSweepExempt(worktree.isMainWorktree, state.alwaysShowDefaultBranchWorkspace) &&
    isInactiveWorkspace(
      worktree.id,
      tabsByWorktree,
      state.ptyIdsByTabId,
      browserTabsByWorktree,
      liveAgentWorktrees,
      structuredChatWorktrees
    )
}
