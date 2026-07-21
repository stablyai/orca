import type React from 'react'

// Why: the Activity terminal portal slots tag their DOM with this attribute so
// embedded xterm focus can be distinguished from ordinary Activity chrome. Keep
// the selector in sync with the data-activity-terminal-slot-id targets rendered
// by ActivityPrototypePage.
const ACTIVITY_TERMINAL_PORTAL_SELECTOR = '[data-activity-terminal-slot-id]'
const XTERM_HELPER_TEXTAREA_CLASS = 'xterm-helper-textarea'

type ActivityEscapeKeyEvent = Pick<React.KeyboardEvent<HTMLDivElement>, 'defaultPrevented' | 'key'>

function hasClassListContains(
  value: unknown
): value is { classList: { contains: (token: string) => boolean } } {
  if (typeof value !== 'object' || value === null || !('classList' in value)) {
    return false
  }
  const { classList } = value
  return (
    typeof classList === 'object' &&
    classList !== null &&
    'contains' in classList &&
    typeof classList.contains === 'function'
  )
}

function hasClosest(value: unknown): value is { closest: (selector: string) => unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'closest' in value &&
    typeof value.closest === 'function'
  )
}

function isElementWithXtermHelperClass(activeElement: unknown): boolean {
  return (
    hasClassListContains(activeElement) &&
    activeElement.classList.contains(XTERM_HELPER_TEXTAREA_CLASS)
  )
}

function isElementInsideActivityTerminalPortal(activeElement: unknown): boolean {
  return (
    hasClosest(activeElement) && Boolean(activeElement.closest(ACTIVITY_TERMINAL_PORTAL_SELECTOR))
  )
}

export function shouldCloseActivityPageOnEscapeKey(
  { defaultPrevented, key }: ActivityEscapeKeyEvent,
  activeElement: unknown
): boolean {
  if (key !== 'Escape' || defaultPrevented) {
    return false
  }

  return (
    !isElementWithXtermHelperClass(activeElement) &&
    !isElementInsideActivityTerminalPortal(activeElement)
  )
}
