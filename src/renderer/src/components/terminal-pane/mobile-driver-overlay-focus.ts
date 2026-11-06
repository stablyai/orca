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

  // Move focus from this pane’s paused xterm to recovery; other panes keep their input focus.
  if (active.classList?.contains?.('xterm-helper-textarea')) {
    return isFocusLike(focusScope) && focusScope.contains?.(active) === true
  }

  // A focused webview owns guest-page typing even though it is not a host-document editable control.
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
