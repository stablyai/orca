const STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX = 'agent-session:'

/** A structured chat's draft belongs to its conversation, so it outlives the tab showing it. */
export function structuredAgentSessionDraftScopeKey(sessionId: string): string {
  return `${STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX}${sessionId}`
}

/** The conversation a structured chat's draft belongs to, or null for a pane's draft. */
export function structuredAgentSessionIdOfDraftScope(scopeKey: string): string | null {
  return scopeKey.startsWith(STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX)
    ? scopeKey.slice(STRUCTURED_AGENT_SESSION_DRAFT_SCOPE_PREFIX.length)
    : null
}

/** A pane key is `<tabId>:<leaf>`; the leaf is a UUID, while a tab id may hold ':' itself. */
export function nativeChatDraftScopeTabId(scopeKey: string): string {
  return scopeKey.slice(0, scopeKey.lastIndexOf(':'))
}

export function nativeChatDraftScopeBelongsToTab(scopeKey: string, tabId: string): boolean {
  return (
    structuredAgentSessionIdOfDraftScope(scopeKey) === null &&
    nativeChatDraftScopeTabId(scopeKey) === tabId
  )
}
