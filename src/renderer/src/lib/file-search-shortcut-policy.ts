import { isEditableTarget } from './editable-target'
import { getShortcutPlatform } from './shortcut-platform'

export function fileSearchClaimsTextKey(event: {
  target: EventTarget | null
  key?: string
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  altGraph?: boolean
  getModifierState?: (key: string) => boolean
}): boolean {
  if (!isEditableTarget(event.target)) {
    return false
  }
  if (
    !(event.target instanceof HTMLInputElement) ||
    !event.target.hasAttribute('data-file-search-input')
  ) {
    return true
  }
  if (
    event.isComposing ||
    event.key === 'Process' ||
    event.key === 'Dead' ||
    event.altGraph ||
    event.getModifierState?.('AltGraph')
  ) {
    return true
  }
  const isMac = getShortcutPlatform() === 'darwin'
  if (event.altKey && isMac && (!event.metaKey || event.ctrlKey)) {
    return true
  }
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!modifier) {
    return true
  }
  const key = event.key?.toLowerCase()
  const physicalLetter = event.code?.match(/^Key([A-Z])$/)?.[1]?.toLowerCase()
  if (!isMac && event.altKey && key?.length === 1 && physicalLetter && key !== physicalLetter) {
    return true
  }
  if (
    (!isMac && key === 'insert') ||
    (!event.altKey && physicalLetter && ['a', 'c', 'v', 'x', 'z', 'y'].includes(physicalLetter))
  ) {
    return true
  }
  // Keep selection, clipboard, undo and word movement with the input.
  if (key && ['arrowleft', 'arrowright', 'home', 'end', 'backspace', 'delete'].includes(key)) {
    return true
  }
  if (!event.altKey && key && ['a', 'c', 'v', 'x', 'z', 'y'].includes(key)) {
    return true
  }
  if ((key === 'arrowup' || key === 'arrowdown') && !event.shiftKey) {
    return true
  }
  return false
}
