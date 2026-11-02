// Preserve published session.tabs row IDs so older clients retain keys and selections (wire rule 3).

import type { LayoutTab } from '../workspace-layout-model'
import { agentSessionRowId } from '../../agent-session/view/structured-agent-session-host-tab-id'

export {
  AGENT_SESSION_ROW_PREFIX,
  agentSessionRowId
} from '../../agent-session/view/structured-agent-session-host-tab-id'

export const TERMINAL_ROW_SEPARATOR = '::'

/** One row per pane: `<terminal id>::<pane id>`, as the window and headless publishers write it. */
export function terminalRowId(entityId: string, leafId: string): string {
  return `${entityId}${TERMINAL_ROW_SEPARATOR}${leafId}`
}

/** Group orders name each tab as its rows do: a terminal by its terminal id (its rows'
 *  `parentTabId`), which differs from the tab id once a switch changed what the tab holds. */
export function publishedTabOrderId(tab: LayoutTab): string {
  return tab.kind === 'agent-session'
    ? agentSessionRowId(tab.entityId, tab.id)
    : tab.kind === 'terminal'
      ? tab.entityId
      : tab.id
}
