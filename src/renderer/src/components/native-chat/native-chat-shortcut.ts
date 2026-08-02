/** Platform-correct binding for the native-chat view toggle.
 *
 *  Key: Cmd/Ctrl + Shift + J. The primary modifier follows AGENTS.md — metaKey
 *  on Mac, ctrlKey elsewhere — and the displayed label uses `⌘`/`⇧` on Mac and
 *  `Ctrl+`/`Shift+` on Linux/Windows.
 */

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

/** Human-readable label for the toggle shortcut, platform-correct. */
export function nativeChatToggleShortcutLabel(isMac: boolean): string {
  return isMac ? '⌘⇧J' : 'Ctrl+Shift+J'
}

/** True when the event is the native-chat toggle chord for the given platform.
 *  Pure so it can be unit-tested without a DOM. */
export function matchesNativeChatToggleShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean
): boolean {
  if (e.altKey || !e.shiftKey) {
    return false
  }
  // Primary modifier is Cmd on Mac, Ctrl on Linux/Windows — and must be the
  // *only* primary modifier so this can't collide with Cmd+Ctrl chords.
  const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary) {
    return false
  }
  return e.key.toLowerCase() === 'j'
}
