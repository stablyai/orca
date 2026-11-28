import type { KeybindingInput } from './types'
import { parseKeybinding } from './parser'
import { modifierStateMatches, keyMatches, resolveModifierToken } from './matching-key'

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
