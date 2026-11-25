import type { KeyboardEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '../text-input/ime/ime-composition-keyboard-event'
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

export function handleScreenFormSubmitKey(event: KeyboardEvent<HTMLFormElement>): void {
  const { currentTarget, target } = event
  if (
    event.defaultPrevented ||
    !(target instanceof HTMLElement) ||
    !currentTarget.contains(target)
  ) {
    return
  }
  const shortcut = isScreenSubmitShortcut(event)
  // A held Enter must not submit when a prerequisite finishes between keydown and keyup.
  if (
    event.repeat &&
    event.key === 'Enter' &&
    !isImeOwnedKeyboardEvent(event) &&
    (shortcut || target instanceof HTMLInputElement || target.matches('button[type="submit"]'))
  ) {
    event.preventDefault()
  } else if (shortcut) {
    event.preventDefault()
    currentTarget.requestSubmit()
  }
}

export function getScreenSubmitModifierLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘' : 'Ctrl'
}

export function getScreenSubmitShortcutLabel(): string {
  return getShortcutPlatform() === 'darwin' ? '⌘ Enter' : 'Ctrl+Enter'
}
