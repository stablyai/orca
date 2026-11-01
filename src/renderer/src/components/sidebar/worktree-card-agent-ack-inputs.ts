import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { isAgentSubjectUnread } from '@/attention/agent-attention-acknowledgement'
import {
  readAgentRowTurnRecords,
  type AgentRowUnreadState
} from '@/components/dashboard/dashboard-row-bucket'

export function selectAgentRowsUnread(
  state: AgentRowUnreadState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey'>[]
): boolean[] {
  const records = readAgentRowTurnRecords(state)
  return agents.map((agent) => isAgentSubjectUnread(records, agent.paneKey))
}
