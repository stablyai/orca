import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import type { DashboardRevealAgentArgs } from '../../../../shared/dashboard-snapshot'

export function revealDashboardAgent(args: DashboardRevealAgentArgs): boolean {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[args.worktreeId]?.find(
    (candidate) =>
      candidate.id === args.tabId &&
      candidate.worktreeId === args.worktreeId &&
      candidate.contentType === 'agent-session'
  )
  if (tab) {
    const owner = structuredAgentSessionOwnerForTab(state, tab)
    const target = structuredAgentSessionTargetForTab(state, tab)
    if (!target) {
      return false
    }
    if (
      activateAndRevealWorkspace(
        args.worktreeId,
        owner ? { executionHostId: owner } : undefined
      ) === false
    ) {
      return false
    }
    return activateStructuredAgentSessionTab({ worktreeId: args.worktreeId, tabId: tab.id, target })
  }
  return revealTerminalPane({
    worktreeId: args.worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    executionHostId: args.executionHostId ?? null
  })
}
