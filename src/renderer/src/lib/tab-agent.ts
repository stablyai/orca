import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TuiAgent } from '../../../shared/types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { agentTypeToIconAgent } from './agent-status'

/**
 * Resolve a terminal tab's agent from hook-reported status — the PRIMARY
 * identity signal for the tab-bar icon (composed by useTabAgent): the same
 * already-computed state that drives the sidebar agent rows, kept live by the
 * OSC 133 command-finished machinery that drops entries when a process exits.
 * Focused-pane resolvers track the pane in view; sibling resolvers cover the
 * rest of a split tab.
 */
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
