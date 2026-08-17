import {
  getEffectiveKeybindingsForDefinition,
  getKeybindingConflictIdentity,
  isDigitIndexActionId,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingOverrides
} from './keybindings'

export type MacDigitRowCode =
  | 'Digit1'
  | 'Digit2'
  | 'Digit3'
  | 'Digit4'
  | 'Digit5'
  | 'Digit6'
  | 'Digit7'
  | 'Digit8'
  | 'Digit9'

type MacCapturedChordModifiers = {
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

export type MacCapturedDigitRowChord = MacCapturedChordModifiers & {
  code: MacDigitRowCode
}

export type MacCapturedDigitChord = MacCapturedChordModifiers & {
  digit: number
}

export type MacSystemHotkeyConflict = {
  actionId: KeybindingActionId
  binding: string
  capturedBindings: string[]
}

// Symbolic hotkeys 118-126 switch to desktops 1-9.
const SWITCH_TO_DESKTOP_HOTKEY_IDS = Array.from({ length: 9 }, (_, index) => 118 + index)
// kVK_ANSI digit-row keycodes are physical positions, not logical digits.
const DIGIT_ROW_CODE_BY_KEYCODE = new Map<number, MacDigitRowCode>([
  [18, 'Digit1'],
  [19, 'Digit2'],
  [20, 'Digit3'],
  [21, 'Digit4'],
  [23, 'Digit5'],
  [22, 'Digit6'],
  [26, 'Digit7'],
  [28, 'Digit8'],
  [25, 'Digit9']
])
// NX device-independent masks from the parameters array.
const SHIFT_MASK = 0x20000
const CONTROL_MASK = 0x40000
const OPTION_MASK = 0x80000
const COMMAND_MASK = 0x100000
const SUPPORTED_MODIFIER_MASK = SHIFT_MASK | CONTROL_MASK | OPTION_MASK | COMMAND_MASK

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function isSupportedParameter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff
}

export function capturedDigitRowChordsFromSymbolicHotkeysJson(
  json: unknown
): MacCapturedDigitRowChord[] {
  const hotkeys = asRecord(asRecord(json)?.AppleSymbolicHotKeys)
  if (!hotkeys) {
    return []
  }
  const chords: MacCapturedDigitRowChord[] = []
  for (const id of SWITCH_TO_DESKTOP_HOTKEY_IDS) {
    const entry = asRecord(hotkeys[String(id)])
    if (entry?.enabled !== true) {
      continue
    }
    const value = asRecord(entry.value)
    const parameters = value?.parameters
    if (value?.type !== 'standard' || !Array.isArray(parameters) || parameters.length !== 3) {
      continue
    }
    const character = parameters[0]
    const keycode = parameters[1]
    const mask = parameters[2]
    if (
      !isSupportedParameter(character) ||
      !isSupportedParameter(keycode) ||
      !isSupportedParameter(mask) ||
      (mask & ~SUPPORTED_MODIFIER_MASK) !== 0
    ) {
      continue
    }
    const code = DIGIT_ROW_CODE_BY_KEYCODE.get(keycode)
    if (!code) {
      continue
    }
    chords.push({
      code,
      meta: (mask & COMMAND_MASK) !== 0,
      control: (mask & CONTROL_MASK) !== 0,
      alt: (mask & OPTION_MASK) !== 0,
      shift: (mask & SHIFT_MASK) !== 0
    })
  }
  return chords
}

type LayoutBaseCharacterReader = (code: MacDigitRowCode) => string | undefined

export function resolveCapturedDigitChordsForLayout(
  chords: readonly MacCapturedDigitRowChord[],
  readBaseCharacter: LayoutBaseCharacterReader
): MacCapturedDigitChord[] {
  const resolved: MacCapturedDigitChord[] = []
  for (const { code, ...modifiers } of chords) {
    const character = readBaseCharacter(code)
    if (!character || !DIGIT_KEY_PATTERN.test(character)) {
      continue
    }
    resolved.push({ digit: Number(character), ...modifiers })
  }
  return resolved
}

function chordToBinding(chord: MacCapturedDigitChord): string {
  const parts: string[] = []
  if (chord.meta) {
    parts.push('Cmd')
  }
  if (chord.control) {
    parts.push('Ctrl')
  }
  if (chord.alt) {
    parts.push('Alt')
  }
  if (chord.shift) {
    parts.push('Shift')
  }
  parts.push(String(chord.digit))
  return parts.join('+')
}

const DIGIT_KEY_PATTERN = /^[1-9]$/

// Expand a digit-index representative across its full 1-9 range.
function candidateBindings(actionId: KeybindingActionId, binding: string): string[] {
  if (!isDigitIndexActionId(actionId)) {
    return [binding]
  }
  const parts = binding.split('+')
  if (!DIGIT_KEY_PATTERN.test(parts.at(-1) ?? '')) {
    return [binding]
  }
  return Array.from({ length: 9 }, (_, index) =>
    [...parts.slice(0, -1), String(index + 1)].join('+')
  )
}

/** Finds Orca bindings intercepted by Mission Control. */
export function findMacSystemHotkeyConflicts(
  definitions: readonly KeybindingDefinition[],
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides | undefined,
  capturedChords: readonly MacCapturedDigitChord[]
): MacSystemHotkeyConflict[] {
  if (capturedChords.length === 0) {
    return []
  }
  const capturedByIdentity = new Map<string, string>()
  for (const chord of capturedChords) {
    const captured = chordToBinding(chord)
    capturedByIdentity.set(getKeybindingConflictIdentity(captured, platform), captured)
  }
  const conflicts: MacSystemHotkeyConflict[] = []
  for (const definition of definitions) {
    for (const binding of getEffectiveKeybindingsForDefinition(definition, platform, overrides)) {
      const capturedBindings = candidateBindings(definition.id, binding)
        .map((candidate) =>
          capturedByIdentity.get(getKeybindingConflictIdentity(candidate, platform))
        )
        .filter((captured): captured is string => captured !== undefined)
      if (capturedBindings.length > 0) {
        conflicts.push({ actionId: definition.id, binding, capturedBindings })
      }
    }
  }
  return conflicts
}
