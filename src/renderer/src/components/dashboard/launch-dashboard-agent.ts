import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { DashboardSpawnAgentArgs } from '../../../../shared/dashboard-snapshot'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'

/** Starts the requested agent through the same host-aware tab path as Quick Launch. */
export function launchDashboardAgent({ worktreeId, agent }: DashboardSpawnAgentArgs): boolean {
  const state = useAppStore.getState()
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree || !isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    return false
  }
  state.setActiveWorktree(worktreeId, executionHostId)
  return (
    launchAgentInNewTab({
      agent,
      worktreeId,
      launchSource: 'unknown'
    }) !== null
  )
}
