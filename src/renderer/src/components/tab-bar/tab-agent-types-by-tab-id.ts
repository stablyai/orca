import { AcceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import {
  agentStatusEntries,
  type AgentStatusRows
} from '../../../../shared/agent-status/contracts/agent-status-rows'
import type { AgentType } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '../native-chat/pane/routing/native-chat-leaf-routing'

export type TabBarAgentProjectionState = {
  agentStatusByPaneKey?: AgentStatusRows
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
}
export type TabBarAgentProjections = {
  tabAgentTypesByTabId: Record<string, AgentType>
  nativeChatTabWideFallbackUnsafeTabsById: Record<string, true>
  revision?: number
}
export function selectTabAgentTypesByTabId(
  statuses: AgentStatusRows,
  layouts: Record<string, TerminalLayoutSnapshot> = {}
): Record<string, AgentType> {
  const types: Record<string, AgentType> = {},
    rows = new Map(agentStatusEntries(statuses)),
    claimed = new Set<string>()
  for (const [tabId, layout] of Object.entries(layouts)) {
    if (layout.root || layout.activeLeafId) {
      claimed.add(tabId)
      const leaf = resolveNativeChatActiveLayoutLeafId(layout),
        agentType = leaf ? rows.get(`${tabId}:${leaf}`)?.agentType : undefined
      if (agentType) {
        types[tabId] = agentType
      }
    }
  }
  for (const [key, row] of rows) {
    const colon = key.indexOf(':'),
      tabId = key.slice(0, colon)
    if (colon <= 0 || claimed.has(tabId)) {
      continue
    }
    claimed.add(tabId)
    if (row.agentType) {
      types[tabId] = row.agentType
    }
  }
  return types
}
export function selectNativeChatTabWideFallbackUnsafeTabsById(
  layouts: Record<string, TerminalLayoutSnapshot> = {}
): Record<string, true> {
  return Object.fromEntries(
    Object.entries(layouts)
      .filter(([, layout]) => !isNativeChatTabWideFallbackSafe(layout))
      .map(([key]) => [key, true])
  )
}
export function createTabBarAgentProjectionSelector(): (
  state: TabBarAgentProjectionState
) => TabBarAgentProjections {
  let source: AgentStatusRows | undefined,
    layouts: TabBarAgentProjectionState['terminalLayoutsByTabId'],
    output: TabBarAgentProjections
  return (state) => {
    if (state.agentStatusByPaneKey instanceof AcceptedAgentStatuses) {
      return state.agentStatusByPaneKey.projection.tabBar()
    }
    if (
      !output ||
      source !== state.agentStatusByPaneKey ||
      layouts !== state.terminalLayoutsByTabId
    ) {
      source = state.agentStatusByPaneKey
      layouts = state.terminalLayoutsByTabId
      output = {
        tabAgentTypesByTabId: selectTabAgentTypesByTabId(source ?? {}, layouts),
        nativeChatTabWideFallbackUnsafeTabsById:
          selectNativeChatTabWideFallbackUnsafeTabsById(layouts)
      }
    }
    return output
  }
}
export const selectTabBarAgentProjections = createTabBarAgentProjectionSelector()
