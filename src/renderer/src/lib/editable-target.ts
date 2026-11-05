import { getShortcutPlatform } from './shortcut-platform'

// Share the capture-listener guard so app/onboarding shortcuts cannot hijack active text edits.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm’s hidden textarea is editable but represents terminal focus, where global shortcuts must still work.
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
