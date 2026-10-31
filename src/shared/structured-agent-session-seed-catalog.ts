import {
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog
} from './agent-session-option-catalog'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'

// Structured picks apply only via live reads/setOption, never terminal launch flags.
const LIVE_ONLY_CATALOG: AgentSessionOptionCatalog = { models: [], modelApply: {} }

/** Share desktop/phone fallback: shipped structured agents use presentation-only built-in seeds. Other agents use a provider placeholder
 * because their terminal catalogs expose CLI flags unavailable to structured sessions. */
export function structuredAgentSessionSeedCatalog(agent: string): AgentSessionOptionCatalog {
  return isAgentSessionHandleProvider(agent)
    ? (getAgentSessionOptionCatalog(agent) ?? LIVE_ONLY_CATALOG)
    : LIVE_ONLY_CATALOG
}
