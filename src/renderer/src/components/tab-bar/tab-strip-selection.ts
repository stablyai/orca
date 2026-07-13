export type TabStripSelectionModifiers = {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

export type TabStripSelectionState = {
  selectedIds: string[]
  anchorId: string | null
  tabStripId?: string | null
}

export function reconcileTabStripSelection(
  selection: TabStripSelectionState,
  visibleTabIds: readonly string[]
): TabStripSelectionState {
  if (selection.selectedIds.length === 0 && selection.anchorId === null) {
    return selection
  }
  const visibleIds = new Set(visibleTabIds)
  const selectedIds = selection.selectedIds.filter((id) => visibleIds.has(id))
  const anchorId =
    selection.anchorId && visibleIds.has(selection.anchorId) ? selection.anchorId : null
  if (selectedIds.length === selection.selectedIds.length && anchorId === selection.anchorId) {
    return selection
  }
  return { selectedIds, anchorId }
}

export function resolveTabStripSelectionClick({
  visibleTabIds,
  clickedId,
  activeId,
  selection,
  modifiers,
  isMac
}: {
  visibleTabIds: readonly string[]
  clickedId: string
  activeId: string | null
  selection: TabStripSelectionState
  modifiers: TabStripSelectionModifiers
  isMac: boolean
}): TabStripSelectionState {
  const clickedIndex = visibleTabIds.indexOf(clickedId)
  if (clickedIndex === -1) {
    return selection
  }

  const anchorId = resolveAnchorId(selection, activeId, clickedId, visibleTabIds)
  if (modifiers.shiftKey) {
    const anchorIndex = visibleTabIds.indexOf(anchorId)
    const start = Math.min(anchorIndex, clickedIndex)
    const end = Math.max(anchorIndex, clickedIndex)
    return {
      selectedIds: visibleTabIds.slice(start, end + 1),
      anchorId
    }
  }

  if (isPlatformToggleModifier(modifiers, isMac)) {
    const selectedIds = toggleSelectedId(
      getToggleBaseSelectedIds(selection, activeId, visibleTabIds),
      clickedId
    )
    return {
      selectedIds,
      anchorId: clickedId
    }
  }

  return {
    selectedIds: [clickedId],
    anchorId: clickedId
  }
}

function resolveAnchorId(
  selection: TabStripSelectionState,
  activeId: string | null,
  clickedId: string,
  visibleTabIds: readonly string[]
): string {
  if (selection.anchorId && visibleTabIds.includes(selection.anchorId)) {
    return selection.anchorId
  }
  if (activeId && visibleTabIds.includes(activeId)) {
    return activeId
  }
  return selection.selectedIds.find((id) => visibleTabIds.includes(id)) ?? clickedId
}

function isPlatformToggleModifier(modifiers: TabStripSelectionModifiers, isMac: boolean): boolean {
  return isMac ? modifiers.metaKey && !modifiers.ctrlKey : modifiers.ctrlKey && !modifiers.metaKey
}

function getToggleBaseSelectedIds(
  selection: TabStripSelectionState,
  activeId: string | null,
  visibleTabIds: readonly string[]
): string[] {
  if (selection.selectedIds.length > 0) {
    return selection.selectedIds
  }
  return activeId && visibleTabIds.includes(activeId) ? [activeId] : []
}

function toggleSelectedId(selectedIds: readonly string[], clickedId: string): string[] {
  if (!selectedIds.includes(clickedId)) {
    return [...selectedIds, clickedId]
  }
  return selectedIds.filter((id) => id !== clickedId)
}
