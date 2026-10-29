import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import { sanitizeRecentTabIds } from '../../store/slices/tab-group-state'

export type TabCycleType = WorkspaceVisibleTabType

export type TypeCyclableTab = {
  type: TabCycleType
  id: string
  tabId?: string
}

type GetNextTabWithinActiveTypeParams = {
  tabs: TypeCyclableTab[]
  activeTabType: TabCycleType
  activeTabId: string | null
  activeFileId: string | null
  activeBrowserTabId: string | null
  activeGroupTabId?: string | null
  direction: number
}

/** Use the matching entity-ID domain; single-type callers need activeAgentSessionEntityId to avoid selecting a background terminal under a structured tab. */
export function getActiveEntityIdForTabType(
  activeTabType: TabCycleType,
  activeTabId: string | null,
  activeFileId: string | null,
  activeBrowserTabId: string | null,
  activeAgentSessionEntityId: string | null = null
): string | null {
  if (activeTabType === 'editor') {
    return activeFileId
  }
  if (activeTabType === 'browser') {
    return activeBrowserTabId
  }
  // activeTabId can still name a background terminal while a structured tab is active.
  if (activeTabType === 'agent-session') {
    return activeAgentSessionEntityId
  }
  if (activeTabType === 'simulator') {
    return activeTabId
  }
  return activeTabId
}

type GetNextTabAcrossAllTypesParams = {
  tabs: TypeCyclableTab[]
  activeTabType: TabCycleType
  activeTabId: string | null
  activeFileId: string | null
  activeBrowserTabId: string | null
  activeGroupTabId?: string | null
  direction: number
}

// Match TabBar dual-ID semantics: prefer unified tab ID for split disambiguation, then backing entity ID.
export function getNextTabAcrossAllTypes({
  tabs,
  activeTabType,
  activeTabId,
  activeFileId,
  activeBrowserTabId,
  activeGroupTabId,
  direction
}: GetNextTabAcrossAllTypesParams): TypeCyclableTab | null {
  if (tabs.length <= 1) {
    return null
  }

  const groupTabIdInNav =
    activeGroupTabId && tabs.some((entry) => entry.tabId === activeGroupTabId)
      ? activeGroupTabId
      : null
  const currentId = getActiveEntityIdForTabType(
    activeTabType,
    activeTabId,
    activeFileId,
    activeBrowserTabId
  )
  const currentIndex = groupTabIdInNav
    ? tabs.findIndex((tab) => tab.tabId === groupTabIdInNav)
    : tabs.findIndex((tab) => tab.type === activeTabType && tab.id === currentId)

  if (currentIndex === -1) {
    return direction < 0 ? tabs.at(-1)! : tabs.at(0)!
  }

  return tabs[(currentIndex + direction + tabs.length) % tabs.length]
}

export function getNextTabWithinActiveType({
  tabs,
  activeTabType,
  activeTabId,
  activeFileId,
  activeBrowserTabId,
  activeGroupTabId,
  direction
}: GetNextTabWithinActiveTypeParams): TypeCyclableTab | null {
  const tabsOfActiveType = tabs.filter((tab) => tab.type === activeTabType)
  if (tabsOfActiveType.length <= 1) {
    return null
  }

  const groupTabIdInNav =
    activeGroupTabId && tabsOfActiveType.some((entry) => entry.tabId === activeGroupTabId)
      ? activeGroupTabId
      : null
  const currentId = getActiveEntityIdForTabType(
    activeTabType,
    activeTabId,
    activeFileId,
    activeBrowserTabId
  )
  const currentIndex = groupTabIdInNav
    ? tabsOfActiveType.findIndex((tab) => tab.tabId === groupTabIdInNav)
    : tabsOfActiveType.findIndex((tab) => tab.id === currentId)

  if (currentIndex === -1) {
    return direction < 0 ? tabsOfActiveType.at(-1)! : tabsOfActiveType.at(0)!
  }

  return tabsOfActiveType[
    (currentIndex + direction + tabsOfActiveType.length) % tabsOfActiveType.length
  ]
}

/** Ctrl+Tab quick-toggle target: the visible tab used just before the active one. */
export function getPreviousRecentTab(
  tabs: readonly TypeCyclableTab[],
  recentTabIds: string[] | undefined,
  activeGroupTabId: string | null
): TypeCyclableTab | null {
  if (!activeGroupTabId) {
    return null
  }
  const visibleTabIds = tabs.flatMap((entry) => (entry.tabId ? [entry.tabId] : []))
  const recent = sanitizeRecentTabIds(recentTabIds, visibleTabIds)
  const currentIndex = recent.lastIndexOf(activeGroupTabId)
  if (currentIndex <= 0) {
    return null
  }
  return tabs.find((entry) => entry.tabId === recent[currentIndex - 1]) ?? null
}
