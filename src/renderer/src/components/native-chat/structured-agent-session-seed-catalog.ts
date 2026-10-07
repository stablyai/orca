import {
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import type { AgentType } from '../../../../shared/agent-status-types'

// Over `agentSession.*` only the live read and `setOption` apply a pick, so no launch apply is named.
const LIVE_ONLY_CATALOG: AgentSessionOptionCatalog = { models: [], modelApply: {} }

/**
 * What a structured chat's picker shows before the session reports its own options. Only the agents
 * every build ships have a seed written against their structured option ids; another agent's
 * terminal catalog names CLI flags and models its structured session never offered, so its picker
 * starts empty and lists exactly what `agentSession.options` reports.
 */
export function structuredAgentSessionSeedCatalog(agent: AgentType): AgentSessionOptionCatalog {
  return isAgentSessionHandleProvider(agent)
    ? (getAgentSessionOptionCatalog(agent) ?? LIVE_ONLY_CATALOG)
    : LIVE_ONLY_CATALOG
}
