import type { KeybindingInput, TextEntryClaim } from './types'
import { getKeybindingPlatform } from './definitions'
import { keyTokenFromInput } from './input'
import { hasModifier } from './parser'

/**
 * Caret and deletion gestures a text surface owns under any modifier combination:
 * macOS alone maps Mod, Alt and Shift onto each of these.
 */
const CARET_AND_DELETION_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Backspace',
  'Delete'
])
const VERTICAL_CARET_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'])
/** Selection, clipboard and undo/redo, which every text surface owns. */
const TEXT_COMMAND_KEYS = new Set(['A', 'C', 'V', 'X', 'Z', 'Y'])
const RICH_TEXT_FORMATTING_KEYS = new Set(['B', 'I', 'U', 'K'])

/**
 * macOS binds Ctrl+letter to editing commands in every text view, so these are text
 * gestures there even though Ctrl is not the platform's primary modifier. Taken from
 * AppKit's StandardKeyBinding.dict: ^a/^e move within the paragraph, ^b/^f move by
 * character, ^d/^h delete, ^k kills to the end, ^o inserts, ^t transposes, ^y yanks.
 * ^l is deliberately absent — it only recenters the view, leaving caret and content
 * untouched, so an app action may claim it.
 */
const MAC_CONTROL_EDITING_KEYS = new Set(['A', 'B', 'D', 'E', 'F', 'H', 'K', 'O', 'T', 'Y'])
/** ^n/^p/^v move by line or page, so only a surface with vertical caret movement owns them. */
const MAC_CONTROL_VERTICAL_CARET_KEYS = new Set(['N', 'P', 'V'])
/**
 * The only Ctrl+Option *letter* chords AppKit binds: ~^b / ~^f move by word, with Shift
 * variants that extend the selection. Option's other text gestures sit on named keys —
 * Option+Backspace and Option+Delete delete a word — which the named-key branch already
 * reserves under any modifier.
 */
const MAC_CONTROL_ALT_WORD_KEYS = new Set(['B', 'F'])

/** Assumed when a caller names the text-entry context without describing the surface. */
export const STRICTEST_TEXT_ENTRY_CLAIM: TextEntryClaim = {
  verticalCaret: true,
  richTextFormatting: true
}

function usesPrimaryModifierOnly(
  input: KeybindingInput,
  platform: NodeJS.Platform,
  allowShift: boolean
): boolean {
  const isMac = getKeybindingPlatform(platform) === 'darwin'
  const primary = hasModifier(input, isMac ? 'meta' : 'control')
  const secondary = hasModifier(input, isMac ? 'control' : 'meta')
  return (
    primary &&
    !secondary &&
    !hasModifier(input, 'alt') &&
    (allowShift || !hasModifier(input, 'shift'))
  )
}

/** Shift is allowed: AppKit pairs every ^key with a ^$key that extends the selection. */
function usesMacControlWithoutCommand(input: KeybindingInput): boolean {
  return hasModifier(input, 'control') && !hasModifier(input, 'meta')
}

/**
 * Whether the focused text surface owns this chord, in which case no app action
 * may claim it. Everything else stays available to the app.
 */
export function isChordReservedForTextEntry(
  input: KeybindingInput,
  claim: TextEntryClaim,
  platform: NodeJS.Platform
): boolean {
  const isMac = getKeybindingPlatform(platform) === 'darwin'
  // Named keys are read straight off the event: no layout or Option composition rewrites
  // them, and several (Home, End) have no token in the binding grammar at all.
  const namedKey = input.key ?? ''
  if (CARET_AND_DELETION_KEYS.has(namedKey)) {
    return true
  }
  if (claim.verticalCaret && VERTICAL_CARET_KEYS.has(namedKey)) {
    return true
  }
  // Why bare Insert stays available: Windows and Linux keep the legacy clipboard chords
  // on Ctrl+Insert and Shift+Insert, but nothing binds Insert alone in a text field, and
  // macOS binds no Insert key at all.
  if (namedKey === 'Insert') {
    const control = hasModifier(input, 'control')
    const shift = hasModifier(input, 'shift')
    // Exactly one of the two: Ctrl+Shift+Insert is nobody's clipboard chord, so an app
    // action may still claim it.
    return !isMac && control !== shift && !hasModifier(input, 'alt') && !hasModifier(input, 'meta')
  }
  // Letters go through the matcher's own resolution rather than the raw key: macOS Option
  // reports a composed character (Option+B -> the integral sign) and a non-Latin layout
  // reports a non-Latin letter, yet a binding still matches through the physical code.
  const key = keyTokenFromInput(input, platform)
  if (!key || key.length !== 1) {
    return false
  }
  if (isMac && usesMacControlWithoutCommand(input)) {
    // Option narrows the family to AppKit's two word-movement chords.
    if (hasModifier(input, 'alt')) {
      return MAC_CONTROL_ALT_WORD_KEYS.has(key)
    }
    if (MAC_CONTROL_EDITING_KEYS.has(key)) {
      return true
    }
    if (claim.verticalCaret && MAC_CONTROL_VERTICAL_CARET_KEYS.has(key)) {
      return true
    }
  }
  // Why Shift is allowed here but not for formatting: Mod+Shift+Z is redo, while bold stays Mod+B.
  if (TEXT_COMMAND_KEYS.has(key) && usesPrimaryModifierOnly(input, platform, true)) {
    return true
  }
  return (
    claim.richTextFormatting &&
    RICH_TEXT_FORMATTING_KEYS.has(key) &&
    usesPrimaryModifierOnly(input, platform, false)
  )
}
