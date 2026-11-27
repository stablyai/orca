import type {
  KeybindingActionId,
  KeybindingInput,
  KeybindingValidationResult,
  ModifierToken,
  NormalizeKeybindingOptions,
  PhysicalModifierToken
} from './types'
import { getKeybindingPlatform, isDigitIndexActionId } from './definitions-support'
import {
  canonicalizeDigitIndexBinding,
  normalizeKeybindingWithOptions,
  normalizeOptionsForAction
} from './normalization'
import { hasModifier } from './parser'
import { keybindingValidationFailure } from './keybinding-diagnostic-copy'

export * from './input-key-identities'
import { keyTokenFromInput } from './input-key-identities'

// Why: the platform primary modifier canonicalizes to Mod (Cmd on macOS / Ctrl elsewhere), mirroring normal capture.
export function canonicalDoubleTapToken(
  modifier: PhysicalModifierToken,
  platform: NodeJS.Platform
): ModifierToken {
  const isMac = platform === 'darwin'
  if (modifier === 'Cmd' && isMac) {
    return 'Mod'
  }
  if (modifier === 'Ctrl' && !isMac) {
    return 'Mod'
  }
  return modifier
}

export function keybindingFromInputWithOptions(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult {
  if (input.doubleTapModifier) {
    return normalizeKeybindingWithOptions(
      `DoubleTap+${canonicalDoubleTapToken(input.doubleTapModifier, platform)}`,
      options
    )
  }
  const key = keyTokenFromInput(input, platform)
  if (!key) {
    return keybindingValidationFailure('modifierOnly')
  }

  const isMac = getKeybindingPlatform(platform) === 'darwin'
  const parts: string[] = []
  const primaryModifierPressed = isMac ? hasModifier(input, 'meta') : hasModifier(input, 'control')
  if (primaryModifierPressed) {
    parts.push('Mod')
  }
  if (isMac && hasModifier(input, 'control')) {
    parts.push('Ctrl')
  }
  if (!isMac && hasModifier(input, 'meta')) {
    parts.push('Cmd')
  }
  if (hasModifier(input, 'alt')) {
    parts.push('Alt')
  }
  if (hasModifier(input, 'shift')) {
    parts.push('Shift')
  }
  parts.push(key)

  return normalizeKeybindingWithOptions(parts.join('+'), options)
}

export function keybindingFromInput(
  input: KeybindingInput,
  platform: NodeJS.Platform
): KeybindingValidationResult {
  return keybindingFromInputWithOptions(input, platform)
}

export function keybindingFromInputForAction(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform
): KeybindingValidationResult {
  const result = keybindingFromInputWithOptions(
    input,
    platform,
    normalizeOptionsForAction(actionId)
  )
  if (!result.ok || !isDigitIndexActionId(actionId)) {
    return result
  }
  return canonicalizeDigitIndexBinding(result.value)
}
