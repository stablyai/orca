export const STATUS_BAR_CONTEXT_MENU_EXEMPT_ATTR = 'data-status-bar-context-menu-exempt'
export const STATUS_BAR_CONTEXT_MENU_EXEMPT_SELECTOR = `[${STATUS_BAR_CONTEXT_MENU_EXEMPT_ATTR}]`
export const STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS = {
  [STATUS_BAR_CONTEXT_MENU_EXEMPT_ATTR]: ''
} as const

const FLOATING_TERMINAL_TOGGLE_SELECTOR = '[data-floating-terminal-toggle]'

type ClosestCapableTarget = EventTarget & {
  closest: (selector: string) => Element | null
}

function hasClosest(target: unknown): target is ClosestCapableTarget {
  return typeof (target as { closest?: unknown } | null)?.closest === 'function'
}

function closestTargetFromEventTarget(target: EventTarget | null): ClosestCapableTarget | null {
  if (hasClosest(target)) {
    return target
  }

  // Why: contextmenu can target Text nodes inside exempt surfaces; their
  // Element parent still carries the opt-out selector.
  const parentElement = (target as { parentElement?: unknown } | null)?.parentElement
  if (hasClosest(parentElement)) {
    return parentElement
  }

  const parentNode = (target as { parentNode?: unknown } | null)?.parentNode
  return hasClosest(parentNode) ? parentNode : null
}

export function shouldOpenStatusBarContextMenu(target: EventTarget | null): boolean {
  const closestTarget = closestTargetFromEventTarget(target)
  if (!closestTarget) {
    return true
  }

  // Why: Radix portal events can still bubble through the StatusBar React tree;
  // nested status-bar surfaces opt out so their right-clicks stay local.
  return (
    closestTarget.closest(FLOATING_TERMINAL_TOGGLE_SELECTOR) === null &&
    closestTarget.closest(STATUS_BAR_CONTEXT_MENU_EXEMPT_SELECTOR) === null
  )
}
