import { getShortcutPlatform } from './shortcut-platform'

type ScreenSubmitShortcutEvent = {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  nativeEvent?: {
    isComposing?: boolean
  }
}

export function isScreenSubmitShortcut(event: ScreenSubmitShortcutEvent): boolean {
  if (event.isComposing || event.nativeEvent?.isComposing) {
    return false
  }
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) {
    return false
  }
  // Why: screen submit is form-local behavior, so it stays fixed to the
  // platform convention instead of reading user-configurable app keybindings.
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
