// Preserve published session.tabs row IDs so older clients retain keys and selections (wire rule 3).

import type { LayoutTab } from '../workspace-layout-model'

export const TERMINAL_ROW_SEPARATOR = '::'
export const AGENT_SESSION_ROW_PREFIX = 'agent-session:'

/** One row per pane: `<terminal id>::<pane id>`, as the window and headless publishers write it. */
export function terminalRowId(entityId: string, leafId: string): string {
  return `${entityId}${TERMINAL_ROW_SEPARATOR}${leafId}`
}

/** Chat rows and group orders both use the provider session ID. */
export function agentSessionRowId(sessionId: string): string {
  return `${AGENT_SESSION_ROW_PREFIX}${sessionId}`
}

export function publishedTabOrderId(tab: LayoutTab): string {
  return tab.kind === 'agent-session' ? agentSessionRowId(tab.entityId) : tab.id
}
