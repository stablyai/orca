import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { customAcpAgentLabelOrFallback, getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { isCustomAcpAgentId } from '../../../../../shared/agent-launch/custom-acp/custom-acp-agent'

export function structuredAgentLabel(agent: AgentType): string {
  if (isCustomAcpAgentId(agent)) {
    return customAcpAgentLabelOrFallback(agent)
  }
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}
