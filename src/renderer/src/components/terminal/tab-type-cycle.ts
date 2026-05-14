export type TabCycleType = 'terminal' | 'editor' | 'browser' | 'notes'

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

export function getActiveEntityIdForTabType(
  activeTabType: TabCycleType,
  activeTabId: string | null,
  activeFileId: string | null,
  activeBrowserTabId: string | null
): string | null {
  if (activeTabType === 'editor') {
    return activeFileId
  }
  if (activeTabType === 'browser') {
    return activeBrowserTabId
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

// Why: companion to getNextTabWithinActiveType for the Cmd/Ctrl+Alt+Shift+]/[
// "cycle across every tab" chord. Keeps the same dual-id matching semantics
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
