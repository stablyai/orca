// Single source for the structured-session tab-id shape; the inverse exists for server-side
// principal classification only (see orchestration-principal.ts for the security boundary).
const STRUCTURED_AGENT_SESSION_TAB_ID_PREFIX = 'structured-agent-session-'

export function structuredAgentSessionTabId(sessionId: string): string {
  return `${STRUCTURED_AGENT_SESSION_TAB_ID_PREFIX}${sessionId}`
}

/** Inverse of structuredAgentSessionTabId; null when the tab id is not a structured-session tab. */
export function structuredAgentSessionIdFromTabId(tabId: string): string | null {
  const sessionId = tabId.startsWith(STRUCTURED_AGENT_SESSION_TAB_ID_PREFIX)
    ? tabId.slice(STRUCTURED_AGENT_SESSION_TAB_ID_PREFIX.length)
    : ''
  return sessionId.length > 0 ? sessionId : null
}
