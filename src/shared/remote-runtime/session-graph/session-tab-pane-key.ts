import { makePaneKey } from '../../workspace-layout/stable-pane-id'
import { chatPaneKey } from '../../agent-session/view/structured-agent-session-projection'

type PaneKeyedTab =
  | { type: 'terminal'; id: string; parentTabId?: string; leafId?: string }
  | { type: 'agent-session'; sessionId: string }
  | { type: string }

export function terminalTabPaneKey(tab: {
  id: string
  parentTabId?: string
  leafId?: string
}): string | undefined {
  if (!tab.leafId) {
    return undefined
  }
  try {
    return makePaneKey(tab.parentTabId ?? tab.id, tab.leafId)
  } catch {
    // An id the pane key grammar refuses has no pane to address.
    return undefined
  }
}

/** The agent pane a session tab shows, as agent status and the desktop Agents list key it. */
export function sessionTabPaneKey(tab: PaneKeyedTab | null | undefined): string | undefined {
  if (tab?.type === 'agent-session' && 'sessionId' in tab) {
    return chatPaneKey(tab.sessionId)
  }
  return tab?.type === 'terminal' && 'id' in tab ? terminalTabPaneKey(tab) : undefined
}
