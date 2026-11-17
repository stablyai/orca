import { getShortcutPlatform } from '../../keyboard/shortcut-platform'

export function isNativeChatPromptTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-native-chat-prompt-editor]') !== null
}

export function isEditorKeyboardTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('[data-editor-keyboard-scope]') !== null
}

// Why: shared across global keyboard listeners (App-level shortcuts and the
// onboarding flow) so an in-progress text edit never gets hijacked by a
// capture-phase keydown handler.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm’s hidden textarea is editable but represents terminal focus, where global shortcuts must still work.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable || isEditorKeyboardTarget(target)) {
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
