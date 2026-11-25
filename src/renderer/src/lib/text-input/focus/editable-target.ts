import { getShortcutPlatform } from '../../keyboard/shortcut-platform'

export function isNativeChatPromptTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-native-chat-prompt-editor]') !== null
}

export function isNativeChatPaneTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-native-chat-root]') !== null
}

// Hidden textareas that stand for terminal, emulator or streamed-page focus, not a text field the user edits.
export const BROWSER_KEYBOARD_PROXY_SELECTOR = '[data-browser-keyboard-proxy]'
export const INPUT_PROXY_SELECTOR = `.xterm-helper-textarea, [data-emulator-keyboard-proxy], ${BROWSER_KEYBOARD_PROXY_SELECTOR}`

// Share the capture-listener guard so app/onboarding shortcuts cannot hijack active text edits.
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // Input proxies are editable, but global shortcuts must still work in their terminal or device.
  if (target.matches(INPUT_PROXY_SELECTOR)) {
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
