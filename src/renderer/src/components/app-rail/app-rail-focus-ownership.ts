import { APP_RAIL_ITEM_ATTRIBUTE, isAppRailItemId, type AppRailItemId } from './AppRailButton'

/**
 * The rail item that owns the current focus: a rail button, or a menu opened from one (followed back through each
 * menu's `aria-labelledby` trigger, so Help's submenu inside More resolves to More). Null for focus anywhere else.
 */
export function railItemOwningFocus(toolbar: HTMLElement): AppRailItemId | null {
  let element: Element | null = document.activeElement
  // Menu → trigger hops: More → Help submenu is the deepest nesting the rail renders.
  for (let hop = 0; element && hop < 4; hop++) {
    if (toolbar.contains(element)) {
      const itemId = element
        .closest(`[${APP_RAIL_ITEM_ATTRIBUTE}]`)
        ?.getAttribute(APP_RAIL_ITEM_ATTRIBUTE)
      return isAppRailItemId(itemId) ? itemId : null
    }
    const menu = element.closest('[role="menu"]')
    const triggerId = menu?.getAttribute('aria-labelledby')
    element = triggerId ? document.getElementById(triggerId) : null
  }
  return null
}
