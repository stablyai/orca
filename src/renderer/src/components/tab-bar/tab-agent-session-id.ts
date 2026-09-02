import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import { resolveNativeChatActiveLayoutLeafId } from '../native-chat/native-chat-leaf-routing'

export type TabAgentSessionIdState = {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  paneForegroundAgentByPaneKey?: Record<string, PaneForegroundAgentEntry>
}

/** Returns the active pane's provider session id when its agent is still live. */
export function resolveTabAgentSessionId(
  state: TabAgentSessionIdState,
  tabId: string
): string | null {
  const leafId = resolveNativeChatActiveLayoutLeafId(state.terminalLayoutsByTabId?.[tabId])
  if (!leafId) {
    return null
  }
  const paneKey = `${tabId}:${leafId}`
  const entry = state.agentStatusByPaneKey?.[paneKey]
  // Hydrated rows may describe a session that ended while no receiver was up.
  if (!entry?.agentType || entry.restoredUnconfirmed === true) {
    return null
  }
  // OSC 133;D proves the pane is back at the shell, regardless of the last hook state.
  if (state.paneForegroundAgentByPaneKey?.[paneKey]?.shellForeground === true) {
    return null
  }
  return entry.providerSession?.id ?? null
}
