import {
  hasModifier,
  isLatinShortcutKey,
  keybindingRunsInTextField,
  type KeybindingActionId,
  type KeybindingInput
} from './keybindings'

export type TextShortcutInput = KeybindingInput & {
  isComposing?: boolean
  altGraph?: boolean
  getModifierState?: (key: string) => boolean
}

export function textInputOwnsComposition(input: TextShortcutInput): boolean {
  return Boolean(
    input.isComposing ||
    input.key === 'Process' ||
    input.key === 'Dead' ||
    input.altGraph ||
    input.getModifierState?.('AltGraph')
  )
}

/** The prompt owns editing and submit keys; unrelated app commands remain available. */
export function nativeChatPromptClaimsShortcut(
  input: TextShortcutInput,
  platform: NodeJS.Platform,
  actionId?: KeybindingActionId
): boolean {
  if (textInputOwnsComposition(input)) {
    return true
  }
  const alt = hasModifier(input, 'alt')
  const meta = hasModifier(input, 'meta')
  const control = hasModifier(input, 'control')
  const key = input.key?.toLowerCase()
  const physicalLetter = input.code?.match(/^Key([A-Z])$/)?.[1]?.toLowerCase()
  const editingLetter = key && isLatinShortcutKey(key) ? key : (physicalLetter ?? key)
  // Electron has no AltGraph flag; a produced character differing from its physical key is text.
  if (
    (platform === 'darwin' && alt && !meta && !control && input.key?.length === 1) ||
    (platform !== 'darwin' &&
      alt &&
      !meta &&
      key?.length === 1 &&
      physicalLetter &&
      key !== physicalLetter)
  ) {
    return true
  }
  if (input.doubleTapModifier) {
    return false
  }
  if (key && ['enter', 'escape', 'tab'].includes(key)) {
    return true
  }
  if (actionId && keybindingRunsInTextField(actionId, input, platform)) {
    return false
  }
  if (
    key &&
    [
      'arrowleft',
      'arrowright',
      'arrowup',
      'arrowdown',
      'home',
      'end',
      'backspace',
      'delete'
    ].includes(key)
  ) {
    return true
  }
  if (!alt && !meta && !control && key?.length === 1) {
    return true
  }
  const primary = platform === 'darwin' ? meta : control
  const editingLetters = hasModifier(input, 'shift')
    ? ['a', 'c', 'v', 'x', 'z']
    : ['a', 'c', 'v', 'x', 'z', 'y']
  if (primary && !alt && editingLetter && editingLetters.includes(editingLetter)) {
    return true
  }
  if (primary && alt && (key === '0' || input.code === 'Digit0')) {
    return true
  }
  if (platform !== 'darwin') {
    return key === 'insert'
  }
  return Boolean(
    control && !meta && !alt && editingLetter && 'abdefhknoptvy'.includes(editingLetter)
  )
}
