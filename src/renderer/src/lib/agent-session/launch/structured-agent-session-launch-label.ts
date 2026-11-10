import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'

export function structuredAgentLabel(agent: AgentType): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}
