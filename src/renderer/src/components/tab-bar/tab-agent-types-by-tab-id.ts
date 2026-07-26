import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '../native-chat/native-chat-leaf-routing'

type TabBarAgentProjectionSelectorDependencies = {
  onStatusEntryVisited?: (paneKey: string) => void
  onAgentTypeLayoutVisited?: (tabId: string) => void
  onUnsafeLayoutVisited?: (tabId: string) => void
}

export type TabBarAgentProjectionState = {
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  settings?: { experimentalNativeChat?: boolean } | null
}

export type TabBarAgentProjections = {
  nativeChatEnabled: boolean
  tabAgentTypesByTabId: Record<string, AgentType>
  nativeChatTabWideFallbackUnsafeTabsById: Record<string, true>
}

const EMPTY_AGENT_STATUS_BY_PANE_KEY: Record<string, AgentStatusEntry> = Object.freeze({})
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: Record<string, TerminalLayoutSnapshot> = Object.freeze({})
const EMPTY_TAB_AGENT_TYPES_BY_TAB_ID: Record<string, AgentType> = Object.freeze({})
const EMPTY_UNSAFE_TABS_BY_ID: Record<string, true> = Object.freeze({})
const DISABLED_TAB_BAR_AGENT_PROJECTIONS: TabBarAgentProjections = Object.freeze({
  nativeChatEnabled: false,
  tabAgentTypesByTabId: EMPTY_TAB_AGENT_TYPES_BY_TAB_ID,
  nativeChatTabWideFallbackUnsafeTabsById: EMPTY_UNSAFE_TABS_BY_ID
})

function reuseRecordIfEqual<T>(
  previous: Record<string, T> | undefined,
  next: Record<string, T>
): Record<string, T> {
  if (!previous) {
    return next
  }
  const nextKeys = Object.keys(next)
  if (Object.keys(previous).length !== nextKeys.length) {
    return next
  }
  return nextKeys.every((key) => previous[key] === next[key]) ? previous : next
}

function projectTabAgentTypesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): Record<string, AgentType> {
  const byTabId: Record<string, AgentType> = {}
  const claimed = new Set<string>()
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
    dependencies?.onAgentTypeLayoutVisited?.(tabId)
    if (!layout.root && !layout.activeLeafId) {
      continue
    }
    claimed.add(tabId)
    const activeLeafId = resolveNativeChatActiveLayoutLeafId(layout)
    if (!activeLeafId) {
      continue
    }
    const entry = agentStatusByPaneKey[`${tabId}:${activeLeafId}`]
    if (entry?.agentType != null) {
      byTabId[tabId] = entry.agentType
    }
  }
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    dependencies?.onStatusEntryVisited?.(paneKey)
    const colon = paneKey.indexOf(':')
    if (colon <= 0) {
      continue
    }
    const tabId = paneKey.slice(0, colon)
    if (claimed.has(tabId)) {
      continue
    }
    claimed.add(tabId)
    if (entry.agentType != null) {
      byTabId[tabId] = entry.agentType
    }
  }
  return byTabId
}

function projectNativeChatTabWideFallbackUnsafeTabsById(
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): Record<string, true> {
  const unsafeTabs: Record<string, true> = {}
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
    dependencies?.onUnsafeLayoutVisited?.(tabId)
    if (!isNativeChatTabWideFallbackSafe(layout)) {
      unsafeTabs[tabId] = true
    }
  }
  return unsafeTabs
}

/**
 * Project `agentStatusByPaneKey` down to the stable `{ terminalTabId: agentType }`
 * the tab strip actually reads (to gate the native-chat view-mode toggle).
 *
 * Why: agent-status pane keys are `${terminalTab.id}:${leafId}` and the tab strip
 * only needs each tab's agent *identity* — which is fixed for the life of the
 * agent. The full `agentStatusByPaneKey` map, however, gets a new top-level
 * identity on every working↔idle status transition app-wide, so subscribing to it
 * whole re-rendered every mounted tab strip on unrelated status churn. Selecting
 * this projection under `useShallow` keeps the result referentially equal across
 * those transitions, so the strip re-renders only when a tab actually gains, loses,
 * or changes its agent.
 *
 * The active layout leaf wins when available because that is where a tab-level
 * chat action opens. Before layout hydration, the first matching pane preserves
 * the legacy lookup behavior (tab ids are colon-free by construction).
 */
export function selectTabAgentTypesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
): Record<string, AgentType> {
  return projectTabAgentTypesByTabId(agentStatusByPaneKey, terminalLayoutsByTabId)
}

export function selectNativeChatTabWideFallbackUnsafeTabsById(
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
): Record<string, true> {
  return projectNativeChatTabWideFallbackUnsafeTabsById(terminalLayoutsByTabId)
}

export function createTabBarAgentProjectionSelector(
  dependencies?: TabBarAgentProjectionSelectorDependencies
): (state: TabBarAgentProjectionState) => TabBarAgentProjections {
  let cachedAgentStatusByPaneKey: Record<string, AgentStatusEntry> | null = null
  let cachedAgentTypeLayoutsByTabId: Record<string, TerminalLayoutSnapshot> | null = null
  let cachedAgentTypesByTabId = EMPTY_TAB_AGENT_TYPES_BY_TAB_ID
  let cachedUnsafeLayoutsByTabId: Record<string, TerminalLayoutSnapshot> | null = null
  let cachedUnsafeTabsById = EMPTY_UNSAFE_TABS_BY_ID
  let cachedEnabledResult: TabBarAgentProjections | null = null

  return (state) => {
    if (state.settings?.experimentalNativeChat !== true) {
      if (cachedEnabledResult) {
        cachedAgentStatusByPaneKey = null
        cachedAgentTypeLayoutsByTabId = null
        cachedAgentTypesByTabId = EMPTY_TAB_AGENT_TYPES_BY_TAB_ID
        cachedUnsafeLayoutsByTabId = null
        cachedUnsafeTabsById = EMPTY_UNSAFE_TABS_BY_ID
        cachedEnabledResult = null
      }
      return DISABLED_TAB_BAR_AGENT_PROJECTIONS
    }

    const statuses = state.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS_BY_PANE_KEY
    const layouts = state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID
    if (statuses !== cachedAgentStatusByPaneKey || layouts !== cachedAgentTypeLayoutsByTabId) {
      cachedAgentTypesByTabId = reuseRecordIfEqual(
        cachedAgentTypesByTabId,
        projectTabAgentTypesByTabId(statuses, layouts, dependencies)
      )
      cachedAgentStatusByPaneKey = statuses
      cachedAgentTypeLayoutsByTabId = layouts
    }
    if (layouts !== cachedUnsafeLayoutsByTabId) {
      cachedUnsafeTabsById = reuseRecordIfEqual(
        cachedUnsafeTabsById,
        projectNativeChatTabWideFallbackUnsafeTabsById(layouts, dependencies)
      )
      cachedUnsafeLayoutsByTabId = layouts
    }
    if (
      cachedEnabledResult?.tabAgentTypesByTabId === cachedAgentTypesByTabId &&
      cachedEnabledResult.nativeChatTabWideFallbackUnsafeTabsById === cachedUnsafeTabsById
    ) {
      return cachedEnabledResult
    }
    cachedEnabledResult = {
      nativeChatEnabled: true,
      tabAgentTypesByTabId: cachedAgentTypesByTabId,
      nativeChatTabWideFallbackUnsafeTabsById: cachedUnsafeTabsById
    }
    return cachedEnabledResult
  }
}

// Why: every retained TabBar requests the same global projection tuple.
export const selectTabBarAgentProjections = createTabBarAgentProjectionSelector()
