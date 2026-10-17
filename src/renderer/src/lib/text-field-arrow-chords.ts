import { isEditableTarget } from './editable-target'
import { getShortcutPlatform } from './shortcut-platform'

type ArrowChordInput = {
  key?: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
}

const MAC_TEXT_FIELD_CHORDS = new Set([
  '',
  'shift',
  'alt',
  'alt+shift',
  'meta',
  'meta+shift',
  'ctrl',
  'ctrl+meta',
  'alt+ctrl+meta'
])
const NON_MAC_TEXT_FIELD_CHORDS = new Set(['', 'shift', 'ctrl', 'ctrl+shift'])

function modifierSignature(input: ArrowChordInput): string {
  const modifiers: string[] = []
  if (input.altKey) {
    modifiers.push('alt')
  }
  if (input.ctrlKey) {
    modifiers.push('ctrl')
  }
  if (input.metaKey) {
    modifiers.push('meta')
  }
  if (input.shiftKey) {
    modifiers.push('shift')
  }
  return modifiers.join('+')
}

export function isArrowChordUnusedByTextFields(
  input: ArrowChordInput,
  platform: NodeJS.Platform
): boolean {
  if (input.key !== 'ArrowUp' && input.key !== 'ArrowDown') {
    return false
  }
  const textFieldChords = platform === 'darwin' ? MAC_TEXT_FIELD_CHORDS : NON_MAC_TEXT_FIELD_CHORDS
  return !textFieldChords.has(modifierSignature(input))
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'tel'])

function isPlainTextField(target: EventTarget | null): boolean {
  if (
    !(target instanceof HTMLElement) ||
    !isEditableTarget(target) ||
    target.closest('.monaco-editor, select') !== null
  ) {
    return false
  }
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.hasAttribute('data-file-search-input')
  }
  return true
}

export function textFieldReleasesArrowChord(
  event: ArrowChordInput & { target: EventTarget | null }
): boolean {
  return (
    isPlainTextField(event.target) && isArrowChordUnusedByTextFields(event, getShortcutPlatform())
  )
}
