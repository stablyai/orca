import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AppState } from '@/store/types'

type AcknowledgedAgentTimesState = Pick<AppState, 'acknowledgedAgentsByPaneKey'>

/** Projects only the acknowledgement timestamps rendered by one card. */
export function selectAcknowledgedAgentTimes(
  state: AcknowledgedAgentTimesState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey'>[]
): number[] {
  return agents.map((agent) => state.acknowledgedAgentsByPaneKey[agent.paneKey] ?? 0)
}
