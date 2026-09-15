import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { DashboardSpawnAgentArgs } from '../../../../shared/dashboard-snapshot'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { registerWorkspaceSurfaceProducer } from '@/lib/workspace-surface-production'
import { settleStructuredAgentSurfaceProducer } from '@/lib/structured-agent-surface-production'

/** Starts the requested agent through the same host-aware tab path as Quick Launch. */
export function launchDashboardAgent({ worktreeId, agent }: DashboardSpawnAgentArgs): boolean {
  const state = useAppStore.getState()
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  if (!worktree || !isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents)) {
    return false
  }
  const producer = registerWorkspaceSurfaceProducer({ workspaceKey: worktreeId, executionHostId })
  try {
    if (activateAndRevealWorktree(worktreeId, { executionHostId }) === false) {
      producer.failed('The workspace is no longer available.')
      return false
    }
    const result = launchAgentInNewTab({
      agent,
      worktreeId,
      launchSource: 'unknown'
    })
    if (!result) {
      producer.failed('The agent launch did not start.')
      return false
    }
    if (result.tabId) {
      producer.materialized({ kind: 'tab', id: result.tabId })
    } else if (result.structuredSettlement) {
      void result.structuredSettlement.then(
        (settlement) => settleStructuredAgentSurfaceProducer(producer, worktreeId, settlement),
        (error: unknown) => producer.failed(error)
      )
    } else {
      producer.failed('The agent launch did not publish a surface.')
    }
    return true
  } catch (error) {
    producer.failed(error)
    return false
  }
}
