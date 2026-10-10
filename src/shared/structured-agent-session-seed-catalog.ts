import {
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog
} from './agent-session-option-catalog'
import { CURSOR_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-gemini-cursor'
import { isAgentSessionHandleProvider } from './agent-session-provider-handle'

// Over `agentSession.*` only the live read and `setOption` apply a pick, so no launch apply is named.
const LIVE_ONLY_CATALOG: AgentSessionOptionCatalog = { models: [], modelApply: {} }

const CURSOR_CONVERSATION_MODE = CURSOR_SESSION_OPTION_CATALOG.structuredConversationMode
const CURSOR_STRUCTURED_SEED_CATALOG: AgentSessionOptionCatalog = {
  models: [],
  modelApply: {},
  hostListingNamesConfiguredModel: true,
  ...(CURSOR_CONVERSATION_MODE ? { structuredConversationMode: CURSOR_CONVERSATION_MODE } : {})
}

/**
 * What a structured chat's picker shows, on desktop and phone alike, before the host catalog or the
 * session answers: one fallback rule for every agent. The agents every build ships a structured
 * seed for start from that built-in list (presentation only; it never makes a launch pick); any
 * other agent's terminal catalog names CLI flags its structured session never offered, so it starts
 * from the provider-default placeholder instead. Cursor has no static models but adds its Agent/Plan
 * mode to every listed model.
 */
export function structuredAgentSessionSeedCatalog(agent: string): AgentSessionOptionCatalog {
  if (agent === 'cursor') {
    return CURSOR_STRUCTURED_SEED_CATALOG
  }
  return isAgentSessionHandleProvider(agent)
    ? (getAgentSessionOptionCatalog(agent) ?? LIVE_ONLY_CATALOG)
    : LIVE_ONLY_CATALOG
}
