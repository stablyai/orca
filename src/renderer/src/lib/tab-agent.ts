import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { RetainedAgentEntry } from '@/store/slices/agent-status/agent-status-contract'
import { agentTypeToIconAgent } from './agent-status'
import {
  firstTabAgentExcludingLeaf,
  selectCompletedTabAgentPanes,
  selectLiveTabAgentPanes,
  selectRetainedTabAgentPanes
} from './tab-agent-status-index'

/** Hook status is primary tab-icon identity, matching sidebar rows and OSC 133 exit cleanup. Resolve focused leaf first, then sibling split panes. */
export function resolveFocusedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TerminalAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    return agentFromStatusEntry(agentStatusByPaneKey[makePaneKey(tabId, activeLeafId)])
  }
  // Hook events can arrive while layout unmounts; without a focused leaf, same-tab hook status remains primary.
  return resolveAnyTabAgent(agentStatusByPaneKey, tabId)
}

export function resolveSiblingTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TerminalAgent | null {
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
): TerminalAgent | null {
  return firstTabAgentExcludingLeaf(
    selectLiveTabAgentPanes(agentStatusByPaneKey, tabId),
    excludedLeafId
  )
}

function agentFromStatusEntry(entry: AgentStatusEntry | undefined): TerminalAgent | null {
  if (!entry || entry.state === 'done') {
    return null
  }
  return agentTypeToIconAgent(entry.agentType)
}

export function resolveFocusedCompletedTabAgent(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TerminalAgent | null {
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
): TerminalAgent | null {
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
): TerminalAgent | null {
  return firstTabAgentExcludingLeaf(
    selectCompletedTabAgentPanes(agentStatusByPaneKey, tabId),
    excludedLeafId
  )
}

function completedAgentFromStatusEntry(entry: AgentStatusEntry | undefined): TerminalAgent | null {
  if (!entry || entry.state !== 'done') {
    return null
  }
  return agentTypeToIconAgent(entry.agentType)
}

export function resolveFocusedRetainedTabAgent(
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TerminalAgent | null {
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
): TerminalAgent | null {
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
): TerminalAgent | null {
  return firstTabAgentExcludingLeaf(
    selectRetainedTabAgentPanes(retainedAgentsByPaneKey, tabId),
    excludedLeafId
  )
}

function agentFromRetainedEntry(entry: RetainedAgentEntry | undefined): TerminalAgent | null {
  return agentTypeToIconAgent(entry?.agentType)
}
