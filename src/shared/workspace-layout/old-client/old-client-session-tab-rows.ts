// Resolve compatible published row IDs back to model tabs/panes without changing older client keys/selections (wire rule 3).

import type { LayoutTab, WorkspaceLayout } from '../workspace-layout-model'
import { layoutContainsLeafId } from '../terminal-pane-tree'
import { publishedTabOrderId, TERMINAL_ROW_SEPARATOR } from './old-client-session-row-ids'

export { agentSessionRowId, publishedTabOrderId, terminalRowId } from './old-client-session-row-ids'
export { projectSessionTabs } from './old-client-session-tabs-projection'

export type SessionTabRowTarget = { tab: LayoutTab; leafId?: string }

/** A row id names the tab whose current content publishes it (`publishedTabOrderId`): terminal::pane
 *  a pane, a bare terminal id its tab, a chat row its chat, any other row its tab. A tab id is
 *  never a match key by itself, so a terminal id a switch left behind names nothing, and a chat's
 *  retired row (its session's row once it reopened under its own) names nothing either. Session
 *  History's session-addressed activation is its own typed step (`resolveChatTabActivation`). A
 *  browser also answers to its workspace. */
export function resolveSessionTabRow(
  workspace: WorkspaceLayout,
  rowId: string
): SessionTabRowTarget | null {
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
  const tab = workspace.tabs.find(
    (entry) =>
      publishedTabOrderId(entry) === rowId || (entry.kind === 'browser' && entry.entityId === rowId)
  )
  return tab ? { tab } : null
}
