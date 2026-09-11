import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { getAgentCatalog } from '@/lib/agent-catalog'

export function structuredAgentLabel(agent: AgentSessionHandleProvider): string {
  return getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
}
