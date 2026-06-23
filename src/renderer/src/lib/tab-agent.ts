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
  return (
    resolveFocusedTabAgent(agentStatusByPaneKey, layout, tabId) ??
    resolveSiblingTabAgent(agentStatusByPaneKey, layout, tabId)
  )
}

export function resolveFocusedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    return agentFromStatusEntry(agentStatusByPaneKey[makePaneKey(tabId, activeLeafId)])
  }
  // Why: hook events can arrive while the terminal layout is temporarily
  // unmounted; with no focused leaf to compare, same-tab hook status is primary.
  return resolveAnyTabAgent(agentStatusByPaneKey, tabId)
}

export function resolveSiblingTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId =
    layout?.activeLeafId && isTerminalLeafId(layout.activeLeafId) ? layout.activeLeafId : null
  if (!activeLeafId) {
    return null
  }
  return resolveAnyTabAgent(agentStatusByPaneKey, tabId, activeLeafId)
}

function resolveAnyTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string,
  excludedLeafId?: string
): TuiAgent | null {
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const parsedPaneKey = parsePaneKey(paneKey)
    if (parsedPaneKey?.tabId === tabId && parsedPaneKey.leafId !== excludedLeafId) {
      const agent = agentFromStatusEntry(entry)
      if (agent) {
        return agent
      }
    }
  }
  return null
}

function agentFromStatusEntry(entry: AgentStatusEntry | undefined): TuiAgent | null {
  if (!entry || entry.state === 'done') {
    return null
  }
  return agentTypeToIconAgent(entry.agentType)
}

export function hasCompletedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string
): boolean {
  return resolveCompletedTabAgent(agentStatusByPaneKey, tabId) !== null
}

export function resolveCompletedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string,
  layout?: TerminalLayoutSnapshot
): TuiAgent | null {
  return (
    resolveFocusedCompletedTabAgent(agentStatusByPaneKey, layout, tabId) ??
    resolveSiblingCompletedTabAgent(agentStatusByPaneKey, layout, tabId)
  )
}

export function resolveFocusedCompletedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    return completedAgentFromStatusEntry(agentStatusByPaneKey[makePaneKey(tabId, activeLeafId)])
  }
  return resolveAnyCompletedTabAgent(agentStatusByPaneKey, tabId)
}

export function resolveSiblingCompletedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId =
    layout?.activeLeafId && isTerminalLeafId(layout.activeLeafId) ? layout.activeLeafId : null
  if (!activeLeafId) {
    return null
  }
  return resolveAnyCompletedTabAgent(agentStatusByPaneKey, tabId, activeLeafId)
}

function resolveAnyCompletedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string,
  excludedLeafId?: string
): TuiAgent | null {
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const parsedPaneKey = parsePaneKey(paneKey)
    if (parsedPaneKey?.tabId === tabId && parsedPaneKey.leafId !== excludedLeafId) {
      const agent = completedAgentFromStatusEntry(entry)
      if (agent) {
        return agent
      }
    }
  }
  return null
}

function completedAgentFromStatusEntry(entry: AgentStatusEntry | undefined): TuiAgent | null {
  if (!entry || entry.state !== 'done') {
    return null
  }
  return agentTypeToIconAgent(entry.agentType)
}
