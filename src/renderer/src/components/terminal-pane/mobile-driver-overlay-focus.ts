type FocusLike = {
  tagName?: string
  isContentEditable?: boolean
  classList?: { contains?: (token: string) => boolean }
  closest?: (selector: string) => unknown
  contains?: (node: unknown) => boolean
}

function isFocusLike(value: unknown): value is FocusLike {
  return typeof value === 'object' && value !== null
}

export function shouldFocusMobileDriverAction(
  active: unknown,
  body?: unknown,
  focusScope?: unknown
): boolean {
  if (!isFocusLike(active) || active === body) {
    return true
  }

  // Why: xterm owns keyboard input through a hidden textarea. When mobile takes
  // that terminal over, focus should move to the recovery action, not stay in
  // the now-paused terminal input. Scope this to the pane that owns the overlay
  // so another active terminal pane keeps keyboard focus.
  if (active.classList?.contains?.('xterm-helper-textarea')) {
    return isFocusLike(focusScope) && focusScope.contains?.(active) === true
  }

  // Why: focused Electron webviews represent guest-page keyboard focus; they
  // are not editable DOM controls in the host document, but stealing focus from
  // them still interrupts the user's typing in the page.
  if (active.tagName === 'WEBVIEW') {
    return false
  }

  if (active.isContentEditable === true) {
    return false
  }

  return !active.closest?.(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  )
}
