/** The id the runtime publishes a chat's session tab row under, in rows and group tab orders. */
export function structuredAgentSessionHostTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

export function isStructuredAgentSessionHostTabId(tabId: string): boolean {
  return tabId.startsWith('agent-session:')
}
