export function focusTabEntryMenuItemAtEdge(
  fromElement: HTMLElement,
  edge: 'first' | 'last'
): boolean {
  const menu = fromElement.closest('[role="menu"]')
  if (!menu) {
    return false
  }
  const items = menu.querySelectorAll<HTMLElement>(
    '[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])'
  )
  const target = edge === 'first' ? items[0] : items.item(items.length - 1)
  if (!target) {
    return false
  }
  target.focus()
  return true
}
