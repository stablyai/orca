import { isImeOwnedKeyboardEvent } from './ime-composition-keyboard-event'
import { getShortcutPlatform } from './shortcut-platform'

type ComposerProjectShortcutEvent = {
  key: string
  code?: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  keyCode?: number
  isComposing?: boolean
  nativeEvent?: {
    keyCode?: number
    isComposing?: boolean
  }
}

export function isComposerProjectShortcut(event: ComposerProjectShortcutEvent): boolean {
  if (isImeOwnedKeyboardEvent(event)) {
    return false
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false
  }
  // Why: on macOS Option+P reports key "π", so match the physical key. Like
  // screen submit, this is form-local behavior and stays fixed instead of
  // reading user-configurable app keybindings.
  return event.code === 'KeyP'
}

export function getComposerProjectShortcutKeys(): string[] {
  return getShortcutPlatform() === 'darwin' ? ['⌥', 'P'] : ['Alt', 'P']
}
