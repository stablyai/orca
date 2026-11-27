import type { KeybindingActionId, KeybindingInput, KeybindingOverrides } from './types'
import { DIGIT_INDEX_KEY_PATTERN } from './definitions'
import { getEffectiveKeybindingsForAction } from './effective'
import { platformModifiers } from './matching-key'
import { hasModifier, parseKeybinding } from './parser'

/** True when `input` holds exactly the modifiers of one of the action's 1–9 chords, so a digit alone would fire it. */
export function holdsDigitIndexModifiers(
  actionId: KeybindingActionId,
  input: KeybindingInput,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): boolean {
  return getEffectiveKeybindingsForAction(actionId, platform, overrides).some((binding) => {
    const parsed = parseKeybinding(binding)
    if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
      return false
    }
    const expected = platformModifiers(parsed, platform)
    // Shift alone is typing, not a held shortcut.
    if (!expected.meta && !expected.control && !expected.alt) {
      return false
    }
    return (
      hasModifier(input, 'meta') === expected.meta &&
      hasModifier(input, 'control') === expected.control &&
      hasModifier(input, 'alt') === expected.alt &&
      hasModifier(input, 'shift') === expected.shift
    )
  })
}
