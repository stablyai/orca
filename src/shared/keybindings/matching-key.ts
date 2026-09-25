import type { KeybindingInput, ModifierToken, ParsedKeybinding } from './types'
import { getKeybindingPlatform } from './definitions'
import { hasModifier } from './parser'
import {
  canFallBackToPhysicalCode,
  logicalKeyTokenFromInput,
  physicalCodeKeyTokenFromInput,
  numpadCodeKeyTokenFromInput,
  isPunctuationKeyToken
} from './input'

export function platformModifiers(
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): { meta: boolean; control: boolean; alt: boolean; shift: boolean } {
  const isMac = platform === 'darwin'
  return {
    meta: parsed.meta || (parsed.mod && isMac),
    control: parsed.control || (parsed.mod && !isMac),
    alt: parsed.alt,
    shift: parsed.shift
  }
}

export function modifierStateMatches(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  const expected = platformModifiers(parsed, platform)
  return (
    hasModifier(input, 'meta') === expected.meta &&
    hasModifier(input, 'control') === expected.control &&
    hasModifier(input, 'alt') === expected.alt &&
    hasModifier(input, 'shift') === expected.shift
  )
}

export function shouldUseMacOptionLetterPhysicalFallback(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: macOS Option+letter reports composed characters (Option+A -> å), leaving no logical Latin key for Alt shortcuts.
  return (
    getKeybindingPlatform(platform) === 'darwin' &&
    parsed.alt &&
    hasModifier(input, 'alt') &&
    logicalKeyTokenFromInput(input) === null
  )
}

export function shouldUseMacOptionPunctuationPhysicalFallback(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: macOS Option+punctuation reports composed dead-key values, leaving no logical bracket token for Alt shortcuts.
  return (
    getKeybindingPlatform(platform) === 'darwin' &&
    parsed.alt &&
    hasModifier(input, 'alt') &&
    logicalKeyTokenFromInput(input) === null
  )
}

export function letterKeyMatches(
  input: KeybindingInput,
  letter: string,
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): boolean {
  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey && logicalKey.length === 1 && logicalKey >= 'A' && logicalKey <= 'Z') {
    return logicalKey === letter.toUpperCase()
  }
  return (
    (canFallBackToPhysicalCode(input, platform) ||
      shouldUseMacOptionLetterPhysicalFallback(parsed, input, platform)) &&
    input.code === `Key${letter.toUpperCase()}`
  )
}

export function digitKeyMatches(
  input: KeybindingInput,
  digit: string,
  platform: NodeJS.Platform
): boolean {
  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey && logicalKey.length === 1 && logicalKey >= '0' && logicalKey <= '9') {
    return logicalKey === digit
  }
  return canFallBackToPhysicalCode(input, platform) && input.code === `Digit${digit}`
}

export function semanticPunctuationKey(input: KeybindingInput): string | null {
  const logicalKey = logicalKeyTokenFromInput(input)
  return isPunctuationKeyToken(logicalKey) ? logicalKey : null
}

export function physicalPunctuationKey(input: KeybindingInput): string | null {
  const physicalKey = physicalCodeKeyTokenFromInput(input)
  return isPunctuationKeyToken(physicalKey) ? physicalKey : null
}

export function shouldUseSemanticPunctuation(
  parsed: ParsedKeybinding,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  // Why: Windows/Linux expose AltGr as Ctrl+Alt; don't turn international text input into Mod+Alt app shortcuts.
  if (
    getKeybindingPlatform(platform) !== 'darwin' &&
    parsed.mod &&
    parsed.alt &&
    hasModifier(input, 'control') &&
    hasModifier(input, 'alt') &&
    !hasModifier(input, 'meta') &&
    physicalPunctuationKey(input) === null
  ) {
    return false
  }
  return true
}

export function keyMatches(
  parsedKey: string,
  input: KeybindingInput,
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): boolean {
  if (parsedKey.length === 1 && parsedKey >= 'A' && parsedKey <= 'Z') {
    return letterKeyMatches(input, parsedKey, parsed, platform)
  }
  if (parsedKey.length === 1 && parsedKey >= '0' && parsedKey <= '9') {
    return digitKeyMatches(input, parsedKey, platform)
  }

  if (parsedKey === 'NumpadAdd' || parsedKey === 'NumpadSubtract') {
    return (
      numpadCodeKeyTokenFromInput(input) === parsedKey ||
      logicalKeyTokenFromInput(input) === parsedKey
    )
  }

  if (isPunctuationKeyToken(parsedKey)) {
    // Why: shortcut labels name logical punctuation, but international layouts can report it from different physical codes.
    const semanticKey = semanticPunctuationKey(input)
    if (semanticKey !== null) {
      if (!shouldUseSemanticPunctuation(parsed, input, platform)) {
        return false
      }
      return semanticKey === parsedKey
    }
    return (
      (canFallBackToPhysicalCode(input, platform) ||
        shouldUseMacOptionPunctuationPhysicalFallback(parsed, input, platform)) &&
      physicalPunctuationKey(input) === parsedKey
    )
  }

  const logicalKey = logicalKeyTokenFromInput(input)
  if (logicalKey !== null) {
    return logicalKey === parsedKey
  }
  return (
    canFallBackToPhysicalCode(input, platform) && physicalCodeKeyTokenFromInput(input) === parsedKey
  )
}

export function resolveModifierToken(
  modifier: ModifierToken,
  platform: NodeJS.Platform
): 'meta' | 'control' | 'alt' | 'shift' {
  switch (modifier) {
    case 'Mod':
      return platform === 'darwin' ? 'meta' : 'control'
    case 'Cmd':
      return 'meta'
    case 'Ctrl':
      return 'control'
    case 'Alt':
      return 'alt'
    case 'Shift':
      return 'shift'
  }
}
