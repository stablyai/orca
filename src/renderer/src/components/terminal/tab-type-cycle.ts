import type { WorkspaceVisibleTabType } from '../../../../shared/tab-types'

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

/**
 * The backing entity id of the active tab, in the same id domain the cyclable entries use.
 *
 * `activeAgentSessionEntityId` is optional because a caller that only compares type-matched
 * entries stays correct without it; a caller that searches a pre-filtered single-type list must
 * pass it, or a structured tab resolves to a live background terminal (see the branch below).
 */
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
  // Why: `activeTabId` is terminal-only state that keeps naming a live background terminal while a
  // structured tab is active, so falling through here cycles from a tab the user is not on.
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

// Why: companion to getNextTabWithinActiveType for the "cycle across every tab"
// chord (Cmd/Ctrl+Shift+]/[ on fresh installs). Keeps the same dual-id matching semantics
// (prefer the active group's unified tabId to disambiguate split layouts, fall
// back to the backing entity id) so behavior matches what the TabBar renders.
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
