import { isImeOwnedKeyboardEvent } from './ime-composition-keyboard-event'
import { getShortcutPlatform } from './shortcut-platform'

type ScreenSubmitShortcutEvent = {
  key: string
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

export function isScreenSubmitShortcut(event: ScreenSubmitShortcutEvent): boolean {
  if (isImeOwnedKeyboardEvent(event)) {
    return false
  }
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) {
    return false
  }
  // Screen submit is form-local platform convention, independent of configurable app shortcuts.
  const platform = getShortcutPlatform()
  return platform === 'darwin'
    ? Boolean(event.metaKey) && !event.ctrlKey
    : Boolean(event.ctrlKey) && !event.metaKey
}

export function getScreenSubmitModifierLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘' : 'Ctrl'
}

export function getScreenSubmitShortcutLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter'
}
