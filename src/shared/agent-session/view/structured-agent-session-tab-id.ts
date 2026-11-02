import { structuredAgentSessionTabId } from './structured-agent-session-projection'

const STRUCTURED_AGENT_SESSION_TAB_PREFIX = structuredAgentSessionTabId('')

/** The chat session a structured tab id names; null for any other tab. */
export function structuredAgentSessionIdFromTabId(tabId: string): string | null {
  return tabId.startsWith(STRUCTURED_AGENT_SESSION_TAB_PREFIX)
    ? tabId.slice(STRUCTURED_AGENT_SESSION_TAB_PREFIX.length)
    : null
}
