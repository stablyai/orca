import type { PlatformBindings, KeybindingActionId } from './types'

export function platformBindings(bindings: readonly string[]): PlatformBindings {
  return {
    darwin: bindings,
    linux: bindings,
    win32: bindings
  }
}

// Each digit-index action is one remappable row: canonicalize to 1, but match any digit 1–9.
export const DIGIT_INDEX_ACTION_IDS: readonly KeybindingActionId[] = [
  'tab.selectByIndex',
  'workspace.selectByIndex'
]

export const DIGIT_INDEX_KEY_PATTERN = /^[1-9]$/

export function isDigitIndexActionId(actionId: KeybindingActionId): boolean {
  return DIGIT_INDEX_ACTION_IDS.includes(actionId)
}

export function getKeybindingPlatform(platform: NodeJS.Platform): 'darwin' | 'linux' | 'win32' {
  return platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'
}
