import type {
  KeybindingActionId,
  KeybindingInput,
  KeybindingValidationResult,
  ModifierToken,
  NormalizeKeybindingOptions,
  PhysicalModifierToken
} from './types'
import { getKeybindingPlatform, isDigitIndexActionId } from './definitions'
import {
  canonicalizeDigitIndexBinding,
  normalizeKeybindingWithOptions,
  normalizeOptionsForAction
} from './normalization'
import { hasModifier, normalizeKeyToken } from './parser'

const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'Control',
  'Meta',
  'Shift',
  'OS',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock'
])

export const PUNCTUATION_KEY_TOKENS = new Set([
  'BracketLeft',
  'BracketRight',
  'Minus',
  'Underscore',
  'Equal',
  'Plus',
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote'
])

export function isPunctuationKeyToken(token: string | null): token is string {
  return token !== null && PUNCTUATION_KEY_TOKENS.has(token)
}

const PHYSICAL_CODE_FALLBACK_KEYS = new Set(['', 'Dead', 'Unidentified'])

const SHIFTED_PUNCTUATION_KEY_TOKENS: Record<string, string> = {
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '~': 'Backquote'
}

export function logicalKeyTokenFromInput(input: KeybindingInput): string | null {
  const key = input.key ?? ''
  if (MODIFIER_KEYS.has(key)) {
    return null
  }
  const normalizedKey = normalizeKeyToken(key)
  if (normalizedKey) {
    return normalizedKey
  }
  if (hasModifier(input, 'shift')) {
    return SHIFTED_PUNCTUATION_KEY_TOKENS[key] ?? null
  }
  return null
}

export function canUsePhysicalCodeFallback(input: KeybindingInput): boolean {
  // Why: layout-aware shortcuts trust real logical keys; physical code is only a fallback when the platform can't report the produced key.
  return PHYSICAL_CODE_FALLBACK_KEYS.has(input.key ?? '')
}

export function isLatinShortcutKey(key: string): boolean {
  // Why: A-Z / 0-9 are the only chars a Latin shortcut names; a non-Latin char (Cyrillic с, Greek π) is never a Latin remap, so physical-code fallback is safe.
  if (key.length !== 1) {
    return false
  }
  const upper = key.toUpperCase()
  return (upper >= 'A' && upper <= 'Z') || (key >= '0' && key <= '9')
}

export function shouldUseNonLatinShortcutPhysicalFallback(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: non-Latin layouts report non-Latin logical keys for physical letters (#6274), breaking Ctrl/Meta shortcuts; fall back to the physical code.
  if (getKeybindingPlatform(platform) === 'darwin') {
    return false
  }
  const hasPrimaryModifier = hasModifier(input, 'control') || hasModifier(input, 'meta')
  if (!hasPrimaryModifier) {
    return false
  }
  // AltGr surfaces as Ctrl+Alt on Windows/Linux; treat it as text, not a chord.
  if (hasModifier(input, 'control') && hasModifier(input, 'alt')) {
    return false
  }
  if (logicalKeyTokenFromInput(input) !== null) {
    return false
  }
  const key = input.key ?? ''
  return key !== '' && !MODIFIER_KEYS.has(key) && !isLatinShortcutKey(key)
}

export function canFallBackToPhysicalCode(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  return (
    canUsePhysicalCodeFallback(input) || shouldUseNonLatinShortcutPhysicalFallback(input, platform)
  )
}

export function physicalCodeKeyTokenFromInput(input: KeybindingInput): string | null {
  const code = input.code ?? ''
  if (code.startsWith('Key') && code.length === 4) {
    return code.slice(3).toUpperCase()
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.slice(5)
  }

  return normalizeKeyToken(code)
}

export function numpadCodeKeyTokenFromInput(input: KeybindingInput): string | null {
  const code = input.code ?? ''
  return code === 'NumpadAdd' || code === 'NumpadSubtract' ? normalizeKeyToken(code) : null
}

export function shouldUseMacOptionComposedCaptureFallback(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: macOS Option+key reports composed characters (Option+C -> ç), so capturing Alt shortcuts needs the physical-code fallback.
  if (
    getKeybindingPlatform(platform) !== 'darwin' ||
    !hasModifier(input, 'alt') ||
    MODIFIER_KEYS.has(input.key ?? '')
  ) {
    return false
  }
  const physicalToken = physicalCodeKeyTokenFromInput(input)
  if (!physicalToken) {
    return false
  }
  return (
    (physicalToken.length === 1 && physicalToken >= 'A' && physicalToken <= 'Z') ||
    isPunctuationKeyToken(physicalToken)
  )
}

export function keyTokenFromInput(
  input: KeybindingInput,
  platform: NodeJS.Platform
): string | null {
  const numpadKey = numpadCodeKeyTokenFromInput(input)
  if (numpadKey) {
    return numpadKey
  }
  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey) {
    return logicalKey
  }
  if (
    !canUsePhysicalCodeFallback(input) &&
    !shouldUseMacOptionComposedCaptureFallback(input, platform) &&
    !shouldUseNonLatinShortcutPhysicalFallback(input, platform)
  ) {
    return null
  }
  return physicalCodeKeyTokenFromInput(input)
}

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
    return { ok: false, error: 'Press a key, not only a modifier.' }
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
