import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { customAcpAgentName } from '../../../../../shared/agent-launch/custom-acp/custom-acp-agent-names'

export function structuredAgentLabel(agent: AgentType): string {
  return (
    getAgentCatalog().find((entry) => entry.id === agent)?.label ??
    customAcpAgentName(agent) ??
    agent
  )
}
