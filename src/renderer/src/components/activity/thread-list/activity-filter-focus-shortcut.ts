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
  // Only Activity-portaled terminals retain terminal Find; hidden workspace terminals stay mounted too.
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
  // Stop Find before hidden focused xterms can forward it to a local/SSH PTY.
  event.stopPropagation()
  event.stopImmediatePropagation()
  input.focus()
  input.select()
  return true
}
