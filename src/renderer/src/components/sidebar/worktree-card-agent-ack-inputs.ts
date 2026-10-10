import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AppState } from '@/store/types'
import { readAgentAttentionUnreadReason } from '@/attention/agent-attention-contract'

type AcknowledgedAgentTimesState = Pick<AppState, 'acknowledgedAgentsByPaneKey'>

type AgentUnreadEmphasisState = AcknowledgedAgentTimesState &
  Pick<AppState, 'unreadAgentCompletionPanes' | 'manuallyUnreadTurnsByPaneKey'>

/** Projects only the acknowledgement timestamps rendered by one card. */
export function selectAcknowledgedAgentTimes(
  state: AcknowledgedAgentTimesState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey'>[]
): number[] {
  return agents.map((agent) => state.acknowledgedAgentsByPaneKey[agent.paneKey] ?? 0)
}

/** Live completions share the workspace's confirmed attention, not a second quiet timer. */
export function selectAgentUnreadEmphasis(
  state: AgentUnreadEmphasisState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey' | 'state' | 'rowSource' | 'entry'>[]
): boolean[] {
  const acknowledgedTimes = selectAcknowledgedAgentTimes(state, agents)
  return agents.map((agent, index) => {
    if (acknowledgedTimes[index] >= agent.entry.stateStartedAt) {
      return false
    }
    if (
      agent.state !== 'done' ||
      agent.rowSource === 'retained' ||
      agent.rowSource === 'subagent'
    ) {
      return true
    }
    if (state.manuallyUnreadTurnsByPaneKey?.[agent.paneKey] === agent.entry.stateStartedAt) {
      return true
    }
    const reason = readAgentAttentionUnreadReason(state.unreadAgentCompletionPanes?.[agent.paneKey])
    return reason !== null && reason !== 'terminal-bell'
  })
}
