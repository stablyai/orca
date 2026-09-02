import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { agentTypeToIconAgent } from './agent-status'
import {
  firstTabAgentExcludingLeaf,
  selectCompletedTabAgentPanes,
  selectLiveTabAgentPanes,
  selectRetainedTabAgentPanes
} from './tab-agent-status-index'

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
  return firstTabAgentExcludingLeaf(
    selectLiveTabAgentPanes(agentStatusByPaneKey, tabId),
    excludedLeafId
  )
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
  return firstTabAgentExcludingLeaf(
    selectCompletedTabAgentPanes(agentStatusByPaneKey, tabId),
    excludedLeafId
  )
}

function completedAgentFromStatusEntry(entry: AgentStatusEntry | undefined): TuiAgent | null {
  if (!entry || entry.state !== 'done') {
    return null
  }
  return agentTypeToIconAgent(entry.agentType)
}

export function resolveFocusedRetainedTabAgent(
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    return agentFromRetainedEntry(retainedAgentsByPaneKey[makePaneKey(tabId, activeLeafId)])
  }
  return resolveAnyRetainedTabAgent(retainedAgentsByPaneKey, tabId)
}

export function resolveSiblingRetainedTabAgent(
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TuiAgent | null {
  const activeLeafId =
    layout?.activeLeafId && isTerminalLeafId(layout.activeLeafId) ? layout.activeLeafId : null
  if (!activeLeafId) {
    return null
  }
  return resolveAnyRetainedTabAgent(retainedAgentsByPaneKey, tabId, activeLeafId)
}

function resolveAnyRetainedTabAgent(
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>,
  tabId: string,
  excludedLeafId?: string
): TuiAgent | null {
  return firstTabAgentExcludingLeaf(
    selectRetainedTabAgentPanes(retainedAgentsByPaneKey, tabId),
    excludedLeafId
  )
}

function agentFromRetainedEntry(entry: RetainedAgentEntry | undefined): TuiAgent | null {
  return agentTypeToIconAgent(entry?.agentType)
}
