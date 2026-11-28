// Drops are drawn against the order the tab bar shows (a bot's pinned Home first), so they commit against it too.

/**
 * The group's next order after moving `activeId` beside `overId` within it; null when nothing moves or either tab is
 * not drawn. The displayed order includes drawn tabs the stored order missed, so committing it writes them in too.
 */
export function reorderWithinDisplayedOrder(
  displayedOrder: readonly string[],
  activeId: string,
  overId: string,
  side: 'left' | 'right'
): string[] | null {
  const overIndex = displayedOrder.indexOf(overId)
  const oldIndex = displayedOrder.indexOf(activeId)
  if (overIndex === -1 || oldIndex === -1) {
    return null
  }
  const rawInsertIndex = overIndex + (side === 'right' ? 1 : 0)
  // Adjust forward insertion after removing the source tab so the target slot does not shift left.
  const nextIndex = oldIndex < rawInsertIndex ? rawInsertIndex - 1 : rawInsertIndex
  if (oldIndex === nextIndex) {
    return null
  }
  const nextOrder = displayedOrder.filter((id) => id !== activeId)
  nextOrder.splice(nextIndex, 0, activeId)
  return nextOrder
}

/** Where a tab from another group lands in this group's stored order: before the tab it is drawn ahead of, else last. */
export function storedIndexForDisplayedDrop(
  storedOrder: readonly string[],
  displayedOrder: readonly string[],
  overId: string,
  side: 'left' | 'right'
): number {
  const overIndex = displayedOrder.indexOf(overId)
  if (overIndex === -1) {
    return storedOrder.length
  }
  const beforeId = displayedOrder[overIndex + (side === 'right' ? 1 : 0)]
  const index = beforeId === undefined ? -1 : storedOrder.indexOf(beforeId)
  return index === -1 ? storedOrder.length : index
}
