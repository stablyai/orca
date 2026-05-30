import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TuiAgent } from '../../../shared/types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { agentTypeToIconAgent } from './agent-status'

/**
 * Resolve a terminal tab's agent from hook-reported status. This is the
 * FALLBACK signal for the tab-bar icon — the live foreground process
 * (see useTabAgent) is the primary, dev-friendly source. Hook status is what
 * drives the icon for SSH/remote panes (where foreground polling is too
 * costly) and during the brief window before the first foreground poll lands.
 *
 * Prefers the focused pane's agent so a split tab's icon tracks the pane in
 * view; falls back to any agent pane in the tab. Returns null when no pane
 * reports an iconable agent.
 */
export function resolveTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    const focused = agentTypeToIconAgent(
      agentStatusByPaneKey[makePaneKey(tabId, activeLeafId)]?.agentType
    )
    if (focused) {
      return focused
    }
  }
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    if (parsePaneKey(paneKey)?.tabId === tabId) {
      const agent = agentTypeToIconAgent(entry.agentType)
      if (agent) {
        return agent
      }
    }
  }
  return null
}
