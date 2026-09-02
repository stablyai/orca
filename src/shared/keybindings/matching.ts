import type {
  KeybindingActionId,
  KeybindingInput,
  KeybindingOverrides,
  KeybindingMatchOptions,
  ParsedKeybinding
} from './types'
import { DEFINITIONS_BY_ID, DIGIT_INDEX_KEY_PATTERN, isDigitIndexActionId } from './definitions'
import { canonicalizeParsedKeybinding, parseKeybinding } from './parser'
import {
  platformModifiers,
  modifierStateMatches,
  keyMatches,
  digitKeyMatches,
  resolveModifierToken
} from './matching-key'
import { getEffectiveKeybindingsForAction, keybindingIsActiveInContext } from './effective'

export function keybindingMatchesInput(
  binding: string,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return false
  }
  // A double-tap binding matches only a synthetic double-tap input (and vice-versa), resolved per platform.
  if (parsed.doubleTapModifier) {
    return (
      input.doubleTapModifier !== undefined &&
      resolveModifierToken(parsed.doubleTapModifier, platform) ===
        resolveModifierToken(input.doubleTapModifier, platform)
    )
  }
  if (input.doubleTapModifier !== undefined) {
    return false
  }
  return (
    modifierStateMatches(parsed, input, platform) && keyMatches(parsed.key, input, parsed, platform)
  )
}

export function keybindingConflictIdentityForParsed(
  parsed: ParsedKeybinding,
  platform: NodeJS.Platform
): string {
  if (parsed.doubleTapModifier) {
    return `DoubleTap:${resolveModifierToken(parsed.doubleTapModifier, platform)}`
  }
  const modifiers = platformModifiers(parsed, platform)
  return [
    modifiers.meta ? 'Meta' : '',
    modifiers.control ? 'Control' : '',
    modifiers.alt ? 'Alt' : '',
    modifiers.shift ? 'Shift' : '',
    parsed.key
  ].join('+')
}

export function getKeybindingConflictIdentity(binding: string, platform: NodeJS.Platform): string {
  const parsed = parseKeybinding(binding)
  return parsed ? keybindingConflictIdentityForParsed(parsed, platform) : binding
}

export function keybindingConflictIdentities(
  actionId: KeybindingActionId,
  binding: string,
  platform: NodeJS.Platform
): readonly string[] {
  const exact = getKeybindingConflictIdentity(binding, platform)
  if (!isDigitIndexActionId(actionId)) {
    return [exact]
  }
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
    return [exact]
  }
  return Array.from({ length: 9 }, (_, index) =>
    keybindingConflictIdentityForParsed({ ...parsed, key: String(index + 1) }, platform)
  )
}

export function keybindingMatchesAction(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): boolean {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  if (!definition) {
    return false
  }
  if (!keybindingIsActiveInContext(definition, options)) {
    return false
  }
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).some((binding) =>
    keybindingMatchesInput(binding, input, platform)
  )
}

export function digitFromInput(input: KeybindingInput, platform: NodeJS.Platform): string | null {
  for (let value = 1; value <= 9; value++) {
    const digit = String(value)
    if (digitKeyMatches(input, digit, platform)) {
      return digit
    }
  }
  return null
}

// Why: a digit-index row's representative chord fires for any 1-9 — reuse its modifiers with the pressed digit via the normal matcher.
export function matchKeybindingDigitIndex(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides,
  options: KeybindingMatchOptions = {}
): number | null {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  if (!definition || !keybindingIsActiveInContext(definition, options)) {
    return null
  }
  const digit = digitFromInput(input, platform)
  if (!digit) {
    return null
  }
  for (const binding of getEffectiveKeybindingsForAction(actionId, platform, overrides)) {
    const parsed = parseKeybinding(binding)
    if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
      continue
    }
    const candidate = canonicalizeParsedKeybinding({ ...parsed, key: digit })
    if (keybindingMatchesInput(candidate, input, platform)) {
      return Number(digit) - 1
    }
  }
  return null
}
