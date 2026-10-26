export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export function nativeChatToggleShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘⇧J' : 'Ctrl+Shift+J'
}

export function matchesNativeChatToggleShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean {
  if (e.altKey || !e.shiftKey) {
    return false
  }
  // Require exactly one primary modifier to avoid colliding with Cmd+Ctrl chords.
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) {
    return false
  }
  return e.key.toLowerCase() === 'j'
}
