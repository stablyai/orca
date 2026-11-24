export function structuredAgentSessionHostTabId(sessionId: string): string {
  return `agent-session:${sessionId}`
}

export function isStructuredAgentSessionHostTabId(tabId: string): boolean {
  return tabId.startsWith('agent-session:')
}

export function isReopenedChatTabId(id: string): boolean {
  return id.startsWith('agent-chat-tab-v1-')
}
