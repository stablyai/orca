// The ids today's `session.tabs.*` payload gives its rows. Rows keep today's ids so old clients'
// keys and selections stay valid (wire rule 3).

import type { LayoutTab } from '../workspace-layout-model'

export const TERMINAL_ROW_SEPARATOR = '::'
export const AGENT_SESSION_ROW_PREFIX = 'agent-session:'

/** One row per pane: `<terminal id>::<pane id>`, as the window and headless publishers write it. */
export function terminalRowId(entityId: string, leafId: string): string {
  return `${entityId}${TERMINAL_ROW_SEPARATOR}${leafId}`
}

/** The runtime publishes chat tabs under their session id, in rows and in group tab orders. */
export function agentSessionRowId(sessionId: string): string {
  return `${AGENT_SESSION_ROW_PREFIX}${sessionId}`
}

/** A tab's entry in a published group tab order. */
export function publishedTabOrderId(tab: LayoutTab): string {
  return tab.kind === 'agent-session' ? agentSessionRowId(tab.entityId) : tab.id
}
