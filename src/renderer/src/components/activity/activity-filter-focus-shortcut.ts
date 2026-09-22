export function isActivityFilterFocusShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  isMac = navigator.userAgent.includes('Mac')
): boolean {
  if (event.key.toLowerCase() !== 'f' || event.shiftKey || event.altKey) {
    return false
  }
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function shouldIgnoreActivityFilterFocusShortcutTarget(
  target: Element | null,
  terminalPortalTargets: (HTMLElement | null)[]
): boolean {
  if (!target) {
    return false
  }
  // Why: workspace terminal stays mounted while Activity is open; only the Activity-portaled terminal keeps Cmd/Ctrl+F for terminal search.
  return terminalPortalTargets.some((portalTarget) => portalTarget?.contains(target) ?? false)
}

export function handleActivityFilterFocusShortcut({
  activeElement,
  event,
  input,
  isMac,
  terminalPortalTargets
}: {
  activeElement: Element | null
  event: Pick<
    KeyboardEvent,
    | 'altKey'
    | 'ctrlKey'
    | 'key'
    | 'metaKey'
    | 'preventDefault'
    | 'shiftKey'
    | 'stopImmediatePropagation'
    | 'stopPropagation'
  >
  input: Pick<HTMLInputElement, 'focus' | 'select'> | null
  isMac?: boolean
  terminalPortalTargets: (HTMLElement | null)[]
}): boolean {
  if (shouldIgnoreActivityFilterFocusShortcutTarget(activeElement, terminalPortalTargets)) {
    return false
  }
  if (!isActivityFilterFocusShortcut(event, isMac)) {
    return false
  }
  if (!input) {
    return false
  }
  event.preventDefault()
  // Why: hidden workspace xterms can retain focus behind Activity; stop the chord before xterm forwards it to a local/SSH PTY.
  event.stopPropagation()
  event.stopImmediatePropagation()
  input.focus()
  input.select()
  return true
}
