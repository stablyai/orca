/** Tab-bar "+" menu rows a user may hide; New Terminal and agents always stay. */
export const NEW_TAB_MENU_HIDEABLE_ITEMS = [
  'browser',
  'new-markdown',
  'open-markdown',
  'mobile-emulator'
] as const

export type NewTabMenuHideableItem = (typeof NEW_TAB_MENU_HIDEABLE_ITEMS)[number]

/** Settings JSON is hand-editable and may come from other app versions, so treat non-arrays as "nothing hidden". */
export function isNewTabMenuItemHidden(
  hiddenItems: unknown,
  item: NewTabMenuHideableItem
): boolean {
  return Array.isArray(hiddenItems) && hiddenItems.includes(item)
}

export function setNewTabMenuItemHidden(
  hiddenItems: unknown,
  item: NewTabMenuHideableItem,
  hidden: boolean
): NewTabMenuHideableItem[] {
  // Rebuild from the known list so stale or unknown entries drop out on the next write.
  return NEW_TAB_MENU_HIDEABLE_ITEMS.filter((candidate) =>
    candidate === item ? hidden : isNewTabMenuItemHidden(hiddenItems, candidate)
  )
}
