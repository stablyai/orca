import { getDomRealm } from './dom-realm'
import { getShortcutPlatform } from './shortcut-platform'

// Why: shared across global keyboard listeners (App-level shortcuts and the
// onboarding flow) so an in-progress text edit never gets hijacked by a
// capture-phase keydown handler.
export function isEditableTarget(target: EventTarget | null): boolean {
  // Why: detached popout nodes live in another document — main-realm
  // instanceof misses them and misroutes app-menu selection actions.
  const { HTMLElement: RealmHTMLElement } = getDomRealm(
    (target as Node | null)?.ownerDocument?.defaultView
  )
  if (!(target instanceof RealmHTMLElement)) {
    return false
  }

  // xterm.js focuses a hidden <textarea class="xterm-helper-textarea"> for
  // keyboard input.  That element IS an editable target, but we must NOT
  // suppress global shortcuts when the terminal itself is focused.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }
  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

export function isSelectAllShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
): boolean {
  if (event.key.toLowerCase() !== 'a' || event.altKey || event.shiftKey) {
    return false
  }
  const platform = getShortcutPlatform()
  return platform === 'darwin'
    ? Boolean(event.metaKey) && !event.ctrlKey
    : Boolean(event.ctrlKey) && !event.metaKey
}
