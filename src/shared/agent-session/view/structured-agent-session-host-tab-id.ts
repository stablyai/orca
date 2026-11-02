// A chat has two ids: its layout tab id (any saved id; main's chat-tab table holds it) and its
// row id on the wire, which paired clients and phones key rows and selections by.

export const AGENT_SESSION_ROW_PREFIX = 'agent-session:'

/** The chat's wire row id: a reopened chat publishes its own tab id, every other chat its
 *  session, so a chat living in a tab that held a terminal never takes that terminal's id. */
export function agentSessionRowId(sessionId: string, tabId?: string | null): string {
  return tabId && isReopenedChatTabId(tabId) ? tabId : `${AGENT_SESSION_ROW_PREFIX}${sessionId}`
}

/** Whether a row id is the session-keyed chat form (a wire id, never a layout tab id). */
export function isStructuredAgentSessionHostTabId(tabId: string): boolean {
  return tabId.startsWith(AGENT_SESSION_ROW_PREFIX)
}

export function isReopenedChatTabId(id: string): boolean {
  return id.startsWith('agent-chat-tab-v1-')
}
