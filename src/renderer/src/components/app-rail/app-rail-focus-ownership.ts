import { APP_RAIL_ITEM_ATTRIBUTE, isAppRailItemId, type AppRailItemId } from './AppRailButton'

/**
 * The rail item that owns the current focus: a rail button, or a menu opened from one (followed back through each
 * menu's `aria-labelledby` trigger, so a row in the account menu resolves to the account button). Null elsewhere.
 */
export function railItemOwningFocus(toolbar: HTMLElement): AppRailItemId | null {
  let element: Element | null = document.activeElement
  // Menu → trigger hops; the rail's menus are one level deep today, the bound only guards against cycles.
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
