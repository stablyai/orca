import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { isAgentSubjectUnread } from '@/attention/agent-attention-acknowledgement'
import {
  readAgentRowTurnRecords,
  type AgentRowUnreadState
} from '@/components/dashboard/rows/dashboard-row-bucket'

export function selectAgentRowsUnread(
  state: AgentRowUnreadState,
  agents: readonly Pick<DashboardAgentRow, 'paneKey'>[]
): boolean[] {
  const records = readAgentRowTurnRecords(state)
  return agents.map((agent) => isAgentSubjectUnread(records, agent.paneKey))
}
