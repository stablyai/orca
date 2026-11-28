// Preserve published session.tabs row IDs so older clients retain keys and selections (wire rule 3).

import { isReopenedChatTabId } from '../../agent-session/view/structured-agent-session-host-tab-id'
import type { LayoutTab } from '../workspace-layout-model'

export { TERMINAL_ROW_SEPARATOR, terminalRowId } from '../stable-pane-id'
export const AGENT_SESSION_ROW_PREFIX = 'agent-session:'

/** Chat rows and group orders both use the provider session ID. */
export function agentSessionRowId(sessionId: string, tabId?: string): string {
  if (tabId && isReopenedChatTabId(tabId)) {
    return tabId
  }
  return `${AGENT_SESSION_ROW_PREFIX}${sessionId}`
}

export function publishedTabOrderId(tab: LayoutTab): string {
  return tab.kind === 'agent-session' ? agentSessionRowId(tab.entityId, tab.id) : tab.id
}
