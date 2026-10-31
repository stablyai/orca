import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { activateStructuredAgentSessionTab } from '@/lib/agent-session/structured-agent-session-tab-activation'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForTab
} from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { workspacePresentationFor } from '@/store/workspace-source-state'
import type { DashboardRevealAgentArgs } from '../../../../shared/dashboard-snapshot'

export function revealDashboardAgent(args: DashboardRevealAgentArgs): boolean {
  const state = useAppStore.getState()
  const worktreeId =
    workspacePresentationFor(state, args.worktreeId)?.displayWorkspaceId ?? args.worktreeId
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === args.tabId && candidate.contentType === 'agent-session'
  )
  if (tab) {
    const owner = structuredAgentSessionOwnerForTab(state, tab)
    const target = structuredAgentSessionTargetForTab(state, tab)
    if (!target) {
      return false
    }
    if (
      activateAndRevealWorkspace(worktreeId, owner ? { executionHostId: owner } : undefined) ===
      false
    ) {
      return false
    }
    return activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id, target })
  }
  return revealTerminalPane({
    worktreeId,
    tabId: args.tabId,
    leafId: args.leafId,
    executionHostId: args.executionHostId ?? null
  })
}
