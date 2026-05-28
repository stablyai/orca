export const STATUS_BAR_CONTEXT_MENU_EXEMPT_ATTR = 'data-status-bar-context-menu-exempt'
export const STATUS_BAR_CONTEXT_MENU_EXEMPT_SELECTOR = `[${STATUS_BAR_CONTEXT_MENU_EXEMPT_ATTR}]`
export const STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS = {
  [STATUS_BAR_CONTEXT_MENU_EXEMPT_ATTR]: ''
} as const

const FLOATING_TERMINAL_TOGGLE_SELECTOR = '[data-floating-terminal-toggle]'

function hasClosest(target: EventTarget | null): target is EventTarget & {
  closest: (selector: string) => Element | null
} {
  return typeof (target as { closest?: unknown } | null)?.closest === 'function'
}

export function shouldOpenStatusBarContextMenu(target: EventTarget | null): boolean {
  if (!hasClosest(target)) {
    return true
  }

  // Why: Radix portal events can still bubble through the StatusBar React tree;
  // nested status-bar surfaces opt out so their right-clicks stay local.
  return (
    target.closest(FLOATING_TERMINAL_TOGGLE_SELECTOR) === null &&
    target.closest(STATUS_BAR_CONTEXT_MENU_EXEMPT_SELECTOR) === null
  )
}
