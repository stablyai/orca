// Resolve compatible published row IDs back to model tabs/panes without changing older client keys/selections (wire rule 3).

import type { LayoutTab, WorkspaceLayout } from '../workspace-layout-model'
import { layoutContainsLeafId } from '../terminal-pane-tree'
import { AGENT_SESSION_ROW_PREFIX, TERMINAL_ROW_SEPARATOR } from './old-client-session-row-ids'

export { agentSessionRowId, publishedTabOrderId, terminalRowId } from './old-client-session-row-ids'
export { projectSessionTabs } from './old-client-session-tabs-projection'

export type SessionTabRowTarget = { tab: LayoutTab; leafId?: string }

/** terminal::pane names a pane, bare terminal names its tab; browser-workspace and chat row IDs name tabs. */
export function resolveSessionTabRow(
  workspace: WorkspaceLayout,
  rowId: string
): SessionTabRowTarget | null {
  const byId = workspace.tabs.find((tab) => tab.id === rowId)
  if (byId) {
    return { tab: byId }
  }
  const separator = rowId.indexOf(TERMINAL_ROW_SEPARATOR)
  if (separator > 0) {
    const entityId = rowId.slice(0, separator)
    const leafId = rowId.slice(separator + TERMINAL_ROW_SEPARATOR.length)
    const tab = workspace.tabs.find(
      (entry) => entry.kind === 'terminal' && entry.entityId === entityId
    )
    return tab?.kind === 'terminal' && layoutContainsLeafId(tab.panes.root, leafId)
      ? { tab, leafId }
      : null
  }
  const sessionId = rowId.startsWith(AGENT_SESSION_ROW_PREFIX)
    ? rowId.slice(AGENT_SESSION_ROW_PREFIX.length)
    : null
  const tab = workspace.tabs.find((entry) =>
    sessionId !== null
      ? entry.kind === 'agent-session' && entry.entityId === sessionId
      : (entry.kind === 'terminal' || entry.kind === 'browser') && entry.entityId === rowId
  )
  return tab ? { tab } : null
}
