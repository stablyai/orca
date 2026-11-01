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
import { keybindingValidationFailure } from './keybinding-diagnostic-copy'

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
  // Prefer real logical keys for layout-aware shortcuts; physical code is fallback only when the produced key is unavailable.
  return PHYSICAL_CODE_FALLBACK_KEYS.has(input.key ?? '')
}

export function isLatinShortcutKey(key: string): boolean {
  // Non-Latin characters such as с/π cannot name Latin shortcuts; physical fallback is safe for A–Z/0–9 remaps.
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
  // Non-Latin logical letters break Ctrl/Meta shortcuts on Windows/Linux; use physical fallback (#6274).
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

export function shouldUseImeProcessChordPhysicalFallback(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // IME-marked text reports Process; modifier chords still need physical matching (#28159).
  if (input.key !== 'Process') {
    return false
  }
  const control = hasModifier(input, 'control')
  const alt = hasModifier(input, 'alt')
  if (getKeybindingPlatform(platform) === 'darwin') {
    // Option alone composes text on macOS, so only Cmd/Ctrl chords qualify.
    return control || hasModifier(input, 'meta')
  }
  // AltGr surfaces as Ctrl+Alt on Windows/Linux; treat it as text, not a chord.
  if (control && alt) {
    return false
  }
  return control || alt || hasModifier(input, 'meta')
}

export function shouldUseDigitRowPhysicalFallback(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // AZERTY and neighbours print Latin-1 legends on the digit row (& é " ' ( - è _ ç à), so
  // the physical Digit code is the layout-independent truth for 1–9 chords (#35985). Legends
  // that also name a punctuation key (AZERTY '-' is Minus on Digit6) follow the same rule.
  // Composition artifacts beyond Latin-1 (macOS Option output like ™ U+2122) stay text.
  if (!/^Digit[0-9]$/.test(input.code ?? '')) {
    return false
  }
  const key = input.key ?? ''
  if (key.length !== 1 || key < '!' || key > 'ÿ') {
    return false
  }
  const isMac = getKeybindingPlatform(platform) === 'darwin'
  const logical = logicalKeyTokenFromInput(input)
  if (logical !== null && (isMac || !isPunctuationKeyToken(logical))) {
    // Why macOS excludes punctuation: Option composes `[` into BracketLeft and the like, and
    // logical keys stay ahead of physical digit codes there (see the digit-index tests).
    return false
  }
  // AltGr surfaces as Ctrl+Alt on Windows/Linux; treat it as text, not a chord.
  return !(isMac === false && hasModifier(input, 'control') && hasModifier(input, 'alt'))
}

/** Digit-index actions store one representative chord; a digit-row legend keys by its physical digit. */
function digitRowLegendInputForDigitIndex(
  input: KeybindingInput,
  platform: NodeJS.Platform
): KeybindingInput {
  if (!shouldUseDigitRowPhysicalFallback(input, platform)) {
    return input
  }
  return { ...input, key: (input.code ?? '').slice(5) }
}

export function canFallBackToPhysicalCode(
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  return (
    canUsePhysicalCodeFallback(input) ||
    shouldUseDigitRowPhysicalFallback(input, platform) ||
    shouldUseNonLatinShortcutPhysicalFallback(input, platform) ||
    shouldUseImeProcessChordPhysicalFallback(input, platform)
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
    (physicalToken.length === 1 && physicalToken >= '0' && physicalToken <= '9') ||
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
    !canFallBackToPhysicalCode(input, platform) &&
    !shouldUseMacOptionComposedCaptureFallback(input, platform)
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
  // Why: only the 1-9 ranged actions key by the physical digit; ordinary actions keep
  // their logical key (AZERTY Alt+- records as Alt+Minus, not Alt+6).
  const result = keybindingFromInputWithOptions(
    isDigitIndexActionId(actionId) ? digitRowLegendInputForDigitIndex(input, platform) : input,
    platform,
    normalizeOptionsForAction(actionId)
  )
  if (!result.ok || !isDigitIndexActionId(actionId)) {
    return result
  }
  return canonicalizeDigitIndexBinding(result.value)
}
