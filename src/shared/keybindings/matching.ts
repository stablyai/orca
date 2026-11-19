import type {
  KeybindingActionId,
  KeybindingInput,
  KeybindingOverrides,
  KeybindingMatchOptions
} from './types'
import { DEFINITIONS_BY_ID, DIGIT_INDEX_KEY_PATTERN } from './definitions'
import { canonicalizeParsedKeybinding, parseKeybinding } from './parser'
import { digitKeyMatches } from './matching-key'
import {
  getDefaultBindings,
  getEffectiveKeybindingsForAction,
  keybindingIsActiveInContext
} from './effective'

export { keybindingMatchesInput } from './matching-input'
import { keybindingMatchesInput } from './matching-input'

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

// Why: decided from the definition and the pressed chord, so re-saving a default never takes it from the field.
export function keybindingRunsInTextField(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  return (
    definition?.allowInTextField === 'non-default-chords' &&
    !getDefaultBindings(definition, platform).some((binding) =>
      keybindingMatchesInput(binding, input, platform)
    )
  )
}

export function keybindingRunsInChatPrompt(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform
): boolean {
  return (
    DEFINITIONS_BY_ID.get(actionId)?.runsInChatPrompt === true ||
    keybindingRunsInTextField(actionId, input, platform)
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
