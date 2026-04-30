export type TabCycleType = 'terminal' | 'editor' | 'browser'

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

  return tabsOfActiveType[
    (currentIndex + direction + tabsOfActiveType.length) % tabsOfActiveType.length
  ]
}
