import {
  getEffectiveKeybindingsForDefinition,
  getKeybindingConflictIdentity,
  isDigitIndexActionId,
  type KeybindingActionId,
  type KeybindingDefinition,
  type KeybindingOverrides
} from './keybindings'

/** A Mission Control "Switch to Desktop" chord WindowServer consumes before app delivery. */
export type MacCapturedDigitChord = {
  digit: number
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

export type MacSystemHotkeyConflict = {
  actionId: KeybindingActionId
  /** Orca's effective binding that can never fire. */
  binding: string
  /** Canonical chords the OS consumes, e.g. ['Ctrl+1', 'Ctrl+2']. */
  capturedBindings: string[]
}

// Symbolic hotkeys 118-126 = Switch to Desktop 1-9; entries appear once the user adds Spaces.
const SWITCH_TO_DESKTOP_HOTKEY_IDS = Array.from({ length: 9 }, (_, index) => 118 + index)
// kVK_ANSI digit-row virtual keycodes (not contiguous: 5↔6 and 7-9 are shuffled).
const DIGIT_BY_KEYCODE = new Map([
  [18, 1],
  [19, 2],
  [20, 3],
  [21, 4],
  [23, 5],
  [22, 6],
  [26, 7],
  [28, 8],
  [25, 9]
])
// NX device-independent modifier masks used in the parameters array.
const SHIFT_MASK = 0x20000
const CONTROL_MASK = 0x40000
const OPTION_MASK = 0x80000
const COMMAND_MASK = 0x100000

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** Parses `defaults export com.apple.symbolichotkeys | plutil -convert json` output into the
 *  digit chords Mission Control consumes. Anything unrecognized is skipped, never guessed. */
export function capturedDigitChordsFromSymbolicHotkeysJson(json: unknown): MacCapturedDigitChord[] {
  const hotkeys = asRecord(asRecord(json)?.AppleSymbolicHotKeys)
  if (!hotkeys) {
    return []
  }
  const chords: MacCapturedDigitChord[] = []
  for (const id of SWITCH_TO_DESKTOP_HOTKEY_IDS) {
    const entry = asRecord(hotkeys[String(id)])
    if (!entry?.enabled) {
      continue
    }
    const parameters = asRecord(entry.value)?.parameters
    if (!Array.isArray(parameters)) {
      continue
    }
    const keycode = parameters[1]
    const mask = parameters[2]
    const digit = typeof keycode === 'number' ? DIGIT_BY_KEYCODE.get(keycode) : undefined
    if (digit === undefined || typeof mask !== 'number') {
      continue
    }
    chords.push({
      digit,
      meta: (mask & COMMAND_MASK) !== 0,
      control: (mask & CONTROL_MASK) !== 0,
      alt: (mask & OPTION_MASK) !== 0,
      shift: (mask & SHIFT_MASK) !== 0
    })
  }
  return chords
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

// A digit-index row's stored chord is a 1-9 representative; expand so every captured digit is checked.
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

/** Finds Orca bindings the OS consumes before delivery — they can never fire, so an
 *  in-app handler fix is impossible and the conflict must be surfaced to the user. */
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
