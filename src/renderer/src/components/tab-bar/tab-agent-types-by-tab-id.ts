import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  isNativeChatTabWideFallbackSafe,
  resolveNativeChatActiveLayoutLeafId
} from '../native-chat/native-chat-leaf-routing'

type TabBarAgentProjectionSelectorDependencies = {
  onStatusEntryVisited?: (paneKey: string) => void
  onStatusComparisonVisited?: (paneKey: string) => void
  onLayoutComparisonVisited?: (tabId: string) => void
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

function layoutClaimsTab(layout: TerminalLayoutSnapshot | undefined): boolean {
  return Boolean(layout && (layout.root || layout.activeLeafId))
}

function activeLeafAgentType(
  tabId: string,
  layout: TerminalLayoutSnapshot,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): AgentType | undefined {
  const activeLeafId = resolveNativeChatActiveLayoutLeafId(layout)
  return activeLeafId
    ? (agentStatusByPaneKey[`${tabId}:${activeLeafId}`]?.agentType ?? undefined)
    : undefined
}

/** Before layout hydration a tab takes its first pane's agent in pane-map insertion order. */
function firstPaneAgentTypes(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  isUnclaimedTab: (tabId: string) => boolean,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): Map<string, AgentType | undefined> {
  const byTabId = new Map<string, AgentType | undefined>()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    dependencies?.onStatusEntryVisited?.(paneKey)
    const colon = paneKey.indexOf(':')
    if (colon <= 0) {
      continue
    }
    const tabId = paneKey.slice(0, colon)
    if (!byTabId.has(tabId) && isUnclaimedTab(tabId)) {
      byTabId.set(tabId, entry.agentType ?? undefined)
    }
  }
  return byTabId
}

function projectTabAgentTypesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): Record<string, AgentType> {
  const byTabId: Record<string, AgentType> = {}
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
    dependencies?.onAgentTypeLayoutVisited?.(tabId)
    if (!layoutClaimsTab(layout)) {
      continue
    }
    const agentType = activeLeafAgentType(tabId, layout, agentStatusByPaneKey)
    if (agentType != null) {
      byTabId[tabId] = agentType
    }
  }
  const firstPanes = firstPaneAgentTypes(
    agentStatusByPaneKey,
    (tabId) => !layoutClaimsTab(terminalLayoutsByTabId[tabId]),
    dependencies
  )
  for (const [tabId, agentType] of firstPanes) {
    if (agentType != null) {
      byTabId[tabId] = agentType
    }
  }
  return byTabId
}

/** True when the projection cannot differ: same pane keys in the same order, and every changed entry keeps its agent. */
function statusChangeKeepsAgentTypes(
  previous: Record<string, AgentStatusEntry>,
  next: Record<string, AgentStatusEntry>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): boolean {
  const previousKeys = Object.keys(previous)
  let index = 0
  for (const paneKey in next) {
    dependencies?.onStatusComparisonVisited?.(paneKey)
    if (previousKeys[index] !== paneKey) {
      return false
    }
    index += 1
    const before = previous[paneKey]
    const entry = next[paneKey]
    if (before !== entry && before?.agentType !== entry?.agentType) {
      return false
    }
  }
  return index === previousKeys.length
}

/** Tab ids whose layout entry was added, replaced or removed. */
function changedLayoutTabIds(
  previous: Record<string, TerminalLayoutSnapshot>,
  next: Record<string, TerminalLayoutSnapshot>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): string[] {
  const changed: string[] = []
  let sharedCount = 0
  for (const tabId in next) {
    dependencies?.onLayoutComparisonVisited?.(tabId)
    sharedCount += tabId in previous ? 1 : 0
    if (previous[tabId] !== next[tabId]) {
      changed.push(tabId)
    }
  }
  // Why: only removals leave previous keys unmatched, so replacements skip the second walk.
  if (sharedCount !== Object.keys(previous).length) {
    for (const tabId in previous) {
      dependencies?.onLayoutComparisonVisited?.(tabId)
      if (!(tabId in next)) {
        changed.push(tabId)
      }
    }
  }
  return changed
}

function patchRecord<T>(
  previous: Record<string, T>,
  patches: Iterable<[string, T | undefined]>
): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const [key, value] of patches) {
    if (previous[key] === value) {
      continue
    }
    next ??= { ...previous }
    if (value === undefined) {
      delete next[key]
    } else {
      next[key] = value
    }
  }
  return next ?? previous
}

function patchTabAgentTypesForLayouts(
  previous: Record<string, AgentType>,
  changedTabIds: readonly string[],
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): Record<string, AgentType> {
  const patches: [string, AgentType | undefined][] = []
  const unclaimed = new Set<string>()
  for (const tabId of changedTabIds) {
    dependencies?.onAgentTypeLayoutVisited?.(tabId)
    const layout = terminalLayoutsByTabId[tabId]
    if (layout && layoutClaimsTab(layout)) {
      patches.push([tabId, activeLeafAgentType(tabId, layout, agentStatusByPaneKey)])
    } else {
      unclaimed.add(tabId)
    }
  }
  if (unclaimed.size > 0) {
    const firstPanes = firstPaneAgentTypes(
      agentStatusByPaneKey,
      (tabId) => unclaimed.has(tabId),
      dependencies
    )
    for (const tabId of unclaimed) {
      patches.push([tabId, firstPanes.get(tabId)])
    }
  }
  return patchRecord(previous, patches)
}

function nativeChatTabWideFallbackUnsafe(
  layout: TerminalLayoutSnapshot | undefined
): true | undefined {
  return layout && !isNativeChatTabWideFallbackSafe(layout) ? true : undefined
}

function projectNativeChatTabWideFallbackUnsafeTabsById(
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
): Record<string, true> {
  const unsafeTabs: Record<string, true> = {}
  for (const [tabId, layout] of Object.entries(terminalLayoutsByTabId)) {
    if (nativeChatTabWideFallbackUnsafe(layout)) {
      unsafeTabs[tabId] = true
    }
  }
  return unsafeTabs
}

function patchNativeChatTabWideFallbackUnsafeTabsById(
  previous: Record<string, true>,
  changedTabIds: readonly string[],
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  dependencies?: TabBarAgentProjectionSelectorDependencies
): Record<string, true> {
  return patchRecord(
    previous,
    changedTabIds.map((tabId): [string, true | undefined] => {
      dependencies?.onUnsafeLayoutVisited?.(tabId)
      return [tabId, nativeChatTabWideFallbackUnsafe(terminalLayoutsByTabId[tabId])]
    })
  )
}

/** Project stable agent identity to avoid status-driven strip rerenders; active leaves win, with first-pane fallback before layout hydration. */
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
  // Why: starting from the empty map lets the first call patch every tab in through the shared diff.
  let cachedLayoutsByTabId = EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID
  let cachedAgentTypesByTabId = EMPTY_TAB_AGENT_TYPES_BY_TAB_ID
  let cachedUnsafeTabsById = EMPTY_UNSAFE_TABS_BY_ID
  let cachedEnabledResult: TabBarAgentProjections | null = null

  return (state) => {
    const nativeChatEnabled = state.settings?.experimentalNativeChat === true
    const statuses = state.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS_BY_PANE_KEY
    const layouts = state.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID
    // Status pings and single-tab layout edits patch affected tabs instead of rescanning thousands of layouts.
    if (statuses !== cachedAgentStatusByPaneKey || layouts !== cachedLayoutsByTabId) {
      // Why: both projections patch from one diff so a layout edit walks the layout map once.
      const changedTabIds =
        layouts === cachedLayoutsByTabId
          ? null
          : changedLayoutTabIds(cachedLayoutsByTabId, layouts, dependencies)
      const statusesKeepAgents =
        cachedAgentStatusByPaneKey !== null &&
        (statuses === cachedAgentStatusByPaneKey ||
          statusChangeKeepsAgentTypes(cachedAgentStatusByPaneKey, statuses, dependencies))
      cachedAgentTypesByTabId = !statusesKeepAgents
        ? reuseRecordIfEqual(
            cachedAgentTypesByTabId,
            projectTabAgentTypesByTabId(statuses, layouts, dependencies)
          )
        : changedTabIds
          ? patchTabAgentTypesForLayouts(
              cachedAgentTypesByTabId,
              changedTabIds,
              statuses,
              layouts,
              dependencies
            )
          : cachedAgentTypesByTabId
      if (changedTabIds) {
        cachedUnsafeTabsById = patchNativeChatTabWideFallbackUnsafeTabsById(
          cachedUnsafeTabsById,
          changedTabIds,
          layouts,
          dependencies
        )
      }
      cachedAgentStatusByPaneKey = statuses
      cachedLayoutsByTabId = layouts
    }
    if (
      cachedEnabledResult?.nativeChatEnabled === nativeChatEnabled &&
      cachedEnabledResult.tabAgentTypesByTabId === cachedAgentTypesByTabId &&
      cachedEnabledResult.nativeChatTabWideFallbackUnsafeTabsById === cachedUnsafeTabsById
    ) {
      return cachedEnabledResult
    }
    cachedEnabledResult = {
      nativeChatEnabled,
      tabAgentTypesByTabId: cachedAgentTypesByTabId,
      nativeChatTabWideFallbackUnsafeTabsById: cachedUnsafeTabsById
    }
    return cachedEnabledResult
  }
}

// Why: every retained TabBar requests the same global projection tuple.
export const selectTabBarAgentProjections = createTabBarAgentProjectionSelector()
