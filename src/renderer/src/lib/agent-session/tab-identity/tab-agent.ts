import {
  isTerminalLeafId,
  makePaneKey
} from '../../../../../shared/workspace-layout/stable-pane-id'
import { agentTypeToIconAgent } from '../../../../../shared/agent-status/presentation/agent-type-icon-agent'
import {
  firstTabAgentExcludingLeaf,
  selectCompletedTabAgentPanes,
  selectLiveTabAgentPanes
} from './tab-agent-status-index'
import type { AcceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'

/** Hook status is primary tab-icon identity, matching sidebar rows and OSC 133 exit cleanup. Resolve focused leaf first, then sibling split panes. */
export function resolveFocusedTabAgent(
  agentStatusByPaneKey: AcceptedAgentStatuses,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TerminalAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    return agentFromStatusEntry(agentStatusByPaneKey.get(makePaneKey(tabId, activeLeafId)))
  }
  // Hook events can arrive while layout unmounts; without a focused leaf, same-tab hook status remains primary.
  return resolveAnyTabAgent(agentStatusByPaneKey, tabId)
}

export function resolveSiblingTabAgent(
  agentStatusByPaneKey: AcceptedAgentStatuses,
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
  agentStatusByPaneKey: AcceptedAgentStatuses,
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
  agentStatusByPaneKey: AcceptedAgentStatuses,
  layout: TerminalLayoutSnapshot | undefined,
  tabId: string
): TerminalAgent | null {
  const activeLeafId = layout?.activeLeafId
  if (activeLeafId && isTerminalLeafId(activeLeafId)) {
    return completedAgentFromStatusEntry(agentStatusByPaneKey.get(makePaneKey(tabId, activeLeafId)))
  }
  return resolveAnyCompletedTabAgent(agentStatusByPaneKey, tabId)
}

export function resolveSiblingCompletedTabAgent(
  agentStatusByPaneKey: AcceptedAgentStatuses,
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
  agentStatusByPaneKey: AcceptedAgentStatuses,
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
