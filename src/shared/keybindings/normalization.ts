import type {
  KeybindingActionId,
  KeybindingValidationResult,
  NormalizeKeybindingOptions
} from './types'
import { DEFINITIONS_BY_ID, DIGIT_INDEX_KEY_PATTERN, isDigitIndexActionId } from './definitions'
import { canonicalizeParsedKeybinding, isSafeBareKey, parseKeybinding } from './parser'

export function normalizeKeybindingWithOptions(
  binding: string,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult {
  const parsed = parseKeybinding(binding)
  if (!parsed) {
    return { ok: false, error: 'Use a shortcut like Ctrl+Shift+P or Cmd+K.' }
  }
  if (parsed.mod && (parsed.meta || parsed.control)) {
    return { ok: false, error: 'Use either Mod or a platform-specific modifier, not both.' }
  }
  if (parsed.doubleTapModifier) {
    return { ok: true, value: canonicalizeParsedKeybinding(parsed) }
  }
  const isShiftInsert = parsed.shift && parsed.key === 'Insert'
  const isBareAllowed = options.allowBareKeybindings === true && isSafeBareKey(parsed)
  const isShiftOnlyAllowed =
    options.allowShiftOnlyKeybindings === true &&
    parsed.shift &&
    !parsed.mod &&
    !parsed.meta &&
    !parsed.control &&
    !parsed.alt
  if (
    !parsed.mod &&
    !parsed.meta &&
    !parsed.control &&
    !parsed.alt &&
    !isShiftInsert &&
    !isBareAllowed &&
    !isShiftOnlyAllowed
  ) {
    return { ok: false, error: 'Include at least one modifier key.' }
  }
  return { ok: true, value: canonicalizeParsedKeybinding(parsed) }
}

export function normalizeKeybinding(binding: string): KeybindingValidationResult {
  return normalizeKeybindingWithOptions(binding)
}

export function isDoubleTapBinding(binding: string): boolean {
  return Boolean(parseKeybinding(binding)?.doubleTapModifier)
}

export function normalizeKeybindingListWithOptions(
  input: string,
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult | string[] {
  const trimmed = input.trim()
  if (!trimmed) {
    return []
  }
  const normalized: string[] = []
  for (const piece of trimmed.split(',')) {
    const result = normalizeKeybindingWithOptions(piece, options)
    if (!result.ok) {
      return result
    }
    if (!normalized.includes(result.value)) {
      normalized.push(result.value)
    }
  }
  return normalized
}

export function normalizeKeybindingList(input: string): KeybindingValidationResult | string[] {
  return normalizeKeybindingListWithOptions(input)
}

export function normalizeKeybindingArrayWithOptions(
  input: readonly string[],
  options: NormalizeKeybindingOptions = {}
): KeybindingValidationResult | string[] {
  const normalized: string[] = []
  for (const binding of input) {
    const piece = normalizeKeybindingListWithOptions(binding, options)
    if (!Array.isArray(piece)) {
      return piece
    }
    for (const normalizedBinding of piece) {
      if (!normalized.includes(normalizedBinding)) {
        normalized.push(normalizedBinding)
      }
    }
  }
  return normalized
}

export function normalizeOptionsForAction(
  actionId: KeybindingActionId
): NormalizeKeybindingOptions {
  const definition = DEFINITIONS_BY_ID.get(actionId)
  return {
    allowBareKeybindings: definition?.allowBareKeybindings === true,
    allowShiftOnlyKeybindings: definition?.allowShiftOnlyKeybindings === true
  }
}

// Why: rewrite a digit-index chord's key to 1 so display and conflict detection stay stable across the 1-9 range; reject any non 1-9 key.
export function canonicalizeDigitIndexBinding(binding: string): KeybindingValidationResult {
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
    return {
      ok: false,
      error: 'Pick a number key 1–9 with a modifier, like Cmd+1 or Ctrl+1.'
    }
  }
  return { ok: true, value: canonicalizeParsedKeybinding({ ...parsed, key: '1' }) }
}

export function finalizeDigitIndexBindings(
  actionId: KeybindingActionId,
  result: KeybindingValidationResult | string[]
): KeybindingValidationResult | string[] {
  if (!isDigitIndexActionId(actionId) || !Array.isArray(result)) {
    return result
  }
  const canonical: string[] = []
  for (const binding of result) {
    const normalized = canonicalizeDigitIndexBinding(binding)
    if (!normalized.ok) {
      return normalized
    }
    if (!canonical.includes(normalized.value)) {
      canonical.push(normalized.value)
    }
  }
  return canonical
}

export function normalizeKeybindingListForAction(
  actionId: KeybindingActionId,
  input: string
): KeybindingValidationResult | string[] {
  return finalizeDigitIndexBindings(
    actionId,
    normalizeKeybindingListWithOptions(input, normalizeOptionsForAction(actionId))
  )
}

export function normalizeKeybindingArrayForAction(
  actionId: KeybindingActionId,
  input: readonly string[]
): KeybindingValidationResult | string[] {
  return finalizeDigitIndexBindings(
    actionId,
    normalizeKeybindingArrayWithOptions(input, normalizeOptionsForAction(actionId))
  )
}
